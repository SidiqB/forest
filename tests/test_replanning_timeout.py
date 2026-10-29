"""Timeout-only edits must not satisfy the required scientific replan gate."""

from copy import deepcopy
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _graph(config=None, *, instructions="Run the baseline computation.", inputs=None):
    return {
        "project_id": "project",
        "goal": "Measure the baseline computation",
        "revision": 4,
        "nodes": [{
            "id": "failed",
            "project_id": "project",
            "branch_id": "main",
            "type": "experiment",
            "title": "Baseline computation",
            "instructions": instructions,
            "revision": 2,
            "config": config or {"kind": "command", "command": ["python", "baseline.py"]},
            "inputs": inputs or [],
            "position": {"x": 0, "y": 0},
            "archived": False,
        }],
        "edges": [],
        "branches": [{"id": "main", "name": "Main", "status": "active", "workspace": ".", "is_main": True}],
    }


def _plan(*, stop="failed", evidence="run-1", commands=None):
    evidence_ids = evidence if isinstance(evidence, list) else [evidence]
    return {
        "action": "continue",
        "rationale": "The repeated route failure requires a changed executable method.",
        "evidence_run_ids": evidence_ids,
        "replanning": {
            "reason": "The current route repeatedly failed.",
            "new_direction": "Use a changed executable baseline method.",
            "goal_alignment": "Continue measuring the current scientific goal.",
            "stop_node_ids": [stop],
            "evidence_run_ids": evidence_ids,
        },
        "commands": commands or [],
    }


def _validate(before, after, plan=None, control=None, runs=None, health=None):
    from research.planning.loop import validate_replanning

    return validate_replanning(
        plan or _plan(),
        before,
        after,
        runs or [{"id": "run-1", "node_id": "failed", "status": "failed"}],
        control or {"replan_required": True, "route_replan_node_ids": ["failed"]},
        health or {"signals": []},
        before["goal"],
    )


@pytest.mark.parametrize(
    ("old_timeout", "new_timeout"),
    [(None, 120), (10, 120), (10, None)],
    ids=["add", "change", "remove"],
)
def test_timeout_only_existing_node_edit_is_not_scientific_replanning(old_timeout, new_timeout):
    config = {"kind": "command", "command": ["python", "baseline.py"]}
    if old_timeout is not None:
        config["timeout"] = old_timeout
    before = _graph(config=deepcopy(config))
    revised = deepcopy(config)
    if new_timeout is None:
        revised.pop("timeout", None)
    else:
        revised["timeout"] = new_timeout
    after = _graph(config=revised)

    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after)


def test_timeout_only_clone_is_not_a_new_scientific_route():
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    after = deepcopy(before)
    clone = deepcopy(before["nodes"][0])
    clone.update(id="clone", title="Administrative timeout copy", revision=0)
    clone["config"]["timeout"] = 120
    after["nodes"].append(clone)

    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after)


@pytest.mark.parametrize("change", ["command", "inputs"])
def test_real_method_or_input_edit_is_admissible(change):
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    after = deepcopy(before)
    if change == "command":
        after["nodes"][0]["config"]["command"] = ["python", "revised.py"]
    else:
        after["nodes"][0]["inputs"] = [{
            "node_id": "source",
            "path": "metrics.json",
            "destination": "input.json",
        }]

    report = _validate(before, after)
    assert report["changed_scientific_node_ids"] == ["failed"]


def test_agent_instruction_edit_is_admissible():
    before = _graph(config={"kind": "agent", "role": "Engineer"})
    after = deepcopy(before)
    after["nodes"][0]["instructions"] = "Implement the revised baseline and record measured output."

    report = _validate(before, after)
    assert report["changed_scientific_node_ids"] == ["failed"]


def _timeout_runs(error="Configured process timeout exceeded", *, node_id="failed", node_revision=2, timeout=10, status="failed"):
    return [{
        "id": f"run-{index}", "node_id": node_id, "node_revision": node_revision,
        "created_at": str(index), "kind": "command", "status": status,
        "config": {
            "kind": "command", "command": ["python", "baseline.py"], "timeout": timeout,
            "research_task_identity": {
                "instructions": "Run the baseline computation.",
                "config": {"kind": "command", "command": ["python", "baseline.py"], "timeout": timeout},
                "inputs": [],
            },
        },
        "error": error,
    } for index in range(3)]


def _repeated_failure_health(run_ids, *, node_id="failed"):
    return {"replan_required": True, "signals": [{
        "kind": "repeated_failure", "node_ids": [node_id], "run_ids": run_ids,
    }]}


def test_actual_repeated_process_timeouts_admit_only_a_higher_timeout_repair():
    from research.planning.route_review import route_health

    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    runs = _timeout_runs()
    for run in runs:
        run["config"]["research_activity"] = "counterexample_check"
    health = route_health(before, runs)
    assert health["replan_required"]
    assert any(signal["kind"] == "repeated_failure" for signal in health["signals"])
    assert any(signal["kind"] == "excessive_counterexample_checks" for signal in health["signals"])
    after = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 120})
    report = _validate(before, after, plan=_plan(evidence=[run["id"] for run in runs]), runs=runs, health=health)
    assert report["changed_scientific_node_ids"] == []
    assert report["repaired_timeout_node_ids"] == ["failed"]


@pytest.mark.parametrize("error", [
    "Configured process timeout exceeded",
    "Command exceeded 10s; output is available at /tmp/forest-command.log",
    "Task exceeded its 10s budget",
])
def test_supported_timeout_receipts_are_causal_but_generic_errors_are_not(error):
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    runs = _timeout_runs(error)
    after = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 120})
    report = _validate(before, after, plan=_plan(evidence=[run["id"] for run in runs]), runs=runs,
                       health=_repeated_failure_health([run["id"] for run in runs]))
    assert report["repaired_timeout_node_ids"] == ["failed"]

    generic = _timeout_runs("The command failed with exit code 1")
    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after, plan=_plan(evidence=[run["id"] for run in generic]), runs=generic,
                  health=_repeated_failure_health([run["id"] for run in generic]))


@pytest.mark.parametrize("new_timeout", [5, float("inf"), float("nan")])
def test_timeout_repair_rejects_decrease_and_nonfinite_limits(new_timeout):
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    runs = _timeout_runs()
    after = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": new_timeout})
    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after, plan=_plan(evidence=[run["id"] for run in runs]), runs=runs,
                  health=_repeated_failure_health([run["id"] for run in runs]))


@pytest.mark.parametrize("mutation", ["wrong_node", "old_revision", "old_timeout", "successful"])
def test_timeout_repair_rejects_stale_wrong_or_successful_evidence(mutation):
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    runs = _timeout_runs()
    if mutation == "wrong_node":
        runs[0]["node_id"] = "other"
    elif mutation == "old_revision":
        runs[0]["node_revision"] = 1
    elif mutation == "old_timeout":
        runs[0]["config"]["timeout"] = 5
    else:
        runs[0]["status"] = "completed"
    after = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 120})
    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after, plan=_plan(evidence=[run["id"] for run in runs]), runs=runs,
                  health=_repeated_failure_health([run["id"] for run in runs]))


def test_timeout_repair_rejects_uncited_and_competing_route_evidence():
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    runs = _timeout_runs()
    after = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 120})
    ids = [run["id"] for run in runs]
    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after, plan=_plan(evidence=[ids[0]]), runs=runs,
                  health=_repeated_failure_health(ids))
    competing = _repeated_failure_health(ids)
    unrelated = {"id": "completed-observation", "node_id": "failed", "node_revision": 2,
                 "status": "completed", "config": {"kind": "command", "timeout": 10},
                 "metrics": {"score": 1}}
    competing["signals"].append({"kind": "excessive_counterexample_checks", "node_ids": ["failed"],
                                  "run_ids": [unrelated["id"]]})
    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after, plan=_plan(evidence=ids + [unrelated["id"]]), runs=runs + [unrelated], health=competing)


def test_timeout_remains_editable_when_replanning_gate_is_off():
    before = _graph(config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10})
    after = deepcopy(before)
    after["nodes"][0]["config"]["timeout"] = 120

    assert _validate(before, after, control={"replan_required": False}) is None


def test_scientific_timeout_normalization_does_not_mutate_inputs_or_shared_identity():
    from research.agents.research_path import task_signature

    before = _graph(
        config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10,
                "research_task_identity": {"instructions": "Run the baseline computation.",
                    "config": {"kind": "command", "command": ["python", "baseline.py"], "timeout": 10},
                    "inputs": []}},
        inputs=[{"node_id": "source", "path": "metrics.json", "destination": "input.json"}],
    )
    after = deepcopy(before)
    after["nodes"][0]["config"]["timeout"] = 120
    before_snapshot = deepcopy(before)
    after_snapshot = deepcopy(after)

    with pytest.raises(ValueError, match="materially changed"):
        _validate(before, after)

    assert before == before_snapshot and after == after_snapshot
    # The shared identity remains operationally sensitive to timeout. Only the
    # required replanning comparison is allowed to ignore that field.
    assert task_signature(before["nodes"][0]) != task_signature(after["nodes"][0])


def test_persisted_apply_plan_rejects_timeout_only_then_admits_method_edit(tmp_path):
    """Exercise rollback and adoption against a disposable persisted project."""
    scenario = r'''
import copy
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
scenario_root = Path(sys.argv[2]).resolve()
database = Path(os.environ["FOREST_DATABASE_URL"].removeprefix("sqlite:///").strip()).resolve()
data = Path(os.environ["FOREST_DATA_DIR"]).resolve()
tmp = Path(os.environ["TMPDIR"]).resolve()
mpl = Path(os.environ["MPLCONFIGDIR"]).resolve()
assert Path(os.environ["PYTHONPATH"]).resolve() == root
assert database.parent == scenario_root
assert tmp.parent == scenario_root and data.parent == scenario_root and mpl.parent == scenario_root
assert len({str(database), str(data), str(tmp), str(mpl)}) == 4

from fastapi.testclient import TestClient
from sqlalchemy import select
from services.api.common import graph_from_db
from services.api.db import Hypothesis, Project, Session, TaskRun, migrate, uid
from services.api.main import app
from research.planning.loop import apply_plan

migrate()
client = TestClient(app, headers={"Authorization": "Bearer forest379-synthetic-owner"})
response = client.post("/api/projects", json={
    "name": "Timeout replan persistence", "goal": "Measure the baseline computation",
    "mode": "manual", "config": {"controller": {"status": "running"}},
})
assert response.status_code == 200, response.text
project = response.json()
pid = project["id"]
graph = client.get("/api/projects/" + pid + "/graph").json()
branch = graph["branches"][0]
node_id = "failed"
node_response = client.post("/api/projects/" + pid + "/graph/commands", json={
    "request_id": uid(), "expected_revision": graph["revision"],
    "operation": "add_node", "params": {
        "id": node_id, "branch_id": branch["id"], "type": "experiment",
        "title": "Baseline computation", "instructions": "Run the baseline computation.",
        "config": {"kind": "command", "command": ["python", "baseline.py"], "timeout": 10},
    },
})
assert node_response.status_code == 200, node_response.text
with Session.begin() as session:
    persisted = session.get(Project, pid)
    persisted.config = {**persisted.config, "controller": {
        "status": "running", "phase": "PLAN", "replan_required": True,
        "route_replan_node_ids": [node_id],
    }}
    failed = TaskRun(
        project_id=pid, node_id=node_id, branch_id=branch["id"],
        request_id=uid(), kind="command", status="failed",
        config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10},
        node_revision=0, output_path="runs/failed",
        resource={"evidence_label": "FIXTURE", "synthetic": True},
    )
    session.add(failed)
    session.flush()
    evidence_id = failed.id

def proposal(config):
    return {
        "action": "continue",
        "rationale": "The repeated route failure requires a changed executable method.",
        "evidence_run_ids": [evidence_id],
        "replanning": {
            "reason": "The current route repeatedly failed.",
            "new_direction": "Use a changed executable baseline method.",
            "goal_alignment": "Continue measuring the current scientific goal.",
            "stop_node_ids": [node_id], "evidence_run_ids": [evidence_id],
        },
        "commands": [{"operation": "edit_node", "targets": [node_id], "params": {"config": config}}],
    }

with Session() as session:
    persisted = session.get(Project, pid)
    before_revision = persisted.revision
    before_config = copy.deepcopy(persisted.config)
    before_graph = graph_from_db(session, persisted)
try:
    apply_plan(pid, "timeout-only-plan", proposal({
        "kind": "command", "command": ["python", "baseline.py"], "timeout": 120,
    }), before_revision)
except ValueError as error:
    assert "materially changed" in str(error)
else:
    raise AssertionError("timeout-only replanning was admitted")
with Session() as session:
    persisted = session.get(Project, pid)
    assert persisted.revision == before_revision
    assert persisted.config == before_config
    assert graph_from_db(session, persisted) == before_graph

with Session() as session:
    current_revision = session.get(Project, pid).revision
result = apply_plan(pid, "method-change-plan", proposal({
    "kind": "command", "command": ["python", "revised.py"], "timeout": 120,
}), current_revision)
assert result["action"] == "continue" and result["applied_commands"] == 1
with Session() as session:
    persisted = session.get(Project, pid)
    current = graph_from_db(session, persisted)
    node = next(item for item in current["nodes"] if item["id"] == node_id)
    assert node["config"]["command"] == ["python", "revised.py"]
    assert persisted.config["controller"]["replan_required"] is False
    assert persisted.config["controller"]["phase"] == "EXECUTE"

# A separate persisted project proves that an actual repeated timeout cause
# admits the operational repair and records no scientific change.
response = client.post("/api/projects", json={
    "name": "Causal timeout repair", "goal": "Measure the baseline computation",
    "mode": "manual", "config": {"controller": {"status": "running"}},
})
assert response.status_code == 200, response.text
causal_project = response.json()
causal_pid = causal_project["id"]
causal_graph = client.get("/api/projects/" + causal_pid + "/graph").json()
causal_branch = causal_graph["branches"][0]
causal_node_id = "causal-timeout-node"
node_response = client.post("/api/projects/" + causal_pid + "/graph/commands", json={
    "request_id": uid(), "expected_revision": causal_graph["revision"],
    "operation": "add_node", "params": {
        "id": causal_node_id, "branch_id": causal_branch["id"], "type": "experiment",
        "title": "Baseline computation", "instructions": "Run the baseline computation.",
        "config": {"kind": "command", "command": ["python", "baseline.py"], "timeout": 10},
    },
})
assert node_response.status_code == 200, node_response.text
with Session.begin() as session:
    persisted = session.get(Project, causal_pid)
    persisted.config = {**persisted.config, "controller": {
        "status": "running", "phase": "PLAN", "replan_required": True,
        "route_replan_node_ids": [causal_node_id],
    }}
    causal_ids = []
    for index in range(3):
        failed = TaskRun(
            project_id=causal_pid, node_id=causal_node_id, branch_id=causal_branch["id"],
            request_id=uid(), kind="command", status="failed",
            config={"kind": "command", "command": ["python", "baseline.py"], "timeout": 10,
                    "research_task_identity": {"instructions": "Run the baseline computation.",
                        "config": {"kind": "command", "command": ["python", "baseline.py"], "timeout": 10},
                        "inputs": []}},
            node_revision=0, output_path="runs/failed-" + str(index),
            error="Configured process timeout exceeded",
            resource={"evidence_label": "FIXTURE", "synthetic": True},
        )
        session.add(failed)
        session.flush()
        causal_ids.append(failed.id)
with Session() as session:
    causal_revision = session.get(Project, causal_pid).revision
causal_plan = {
    "action": "continue",
    "rationale": "The recorded process timeout failures require a larger operational limit.",
    "evidence_run_ids": causal_ids,
    "replanning": {
        "reason": "The current process limit caused each recorded failure.",
        "new_direction": "Resume the same computation with a higher operational limit.",
        "goal_alignment": "Preserve the current scientific computation without changing its method.",
        "stop_node_ids": [causal_node_id], "evidence_run_ids": causal_ids,
    },
    "commands": [{"operation": "edit_node", "targets": [causal_node_id], "params": {
        "config": {"kind": "command", "command": ["python", "baseline.py"], "timeout": 120},
    }}],
}
causal_result = apply_plan(causal_pid, "causal-timeout-plan", causal_plan, causal_revision)
assert causal_result["action"] == "continue" and causal_result["applied_commands"] == 1
with Session() as session:
    persisted = session.get(Project, causal_pid)
    current = graph_from_db(session, persisted)
    node = next(item for item in current["nodes"] if item["id"] == causal_node_id)
    assert node["config"]["timeout"] == 120
    assert persisted.config["controller"]["replan_required"] is False
    assert persisted.config["controller"]["phase"] == "EXECUTE"
    decision = session.scalars(select(Hypothesis).where(Hypothesis.project_id == causal_pid).order_by(Hypothesis.created_at.desc())).first()
    assert decision.data["replanning"]["changed_scientific_node_ids"] == []
    assert decision.data["replanning"]["repaired_timeout_node_ids"] == [causal_node_id]
client.close()
'''
    env = {
        "FOREST_DATABASE_URL": f"sqlite:///{tmp_path / 'planning.db'}",
        "FOREST_DATA_DIR": str(tmp_path / "data"),
        "FOREST_MODEL": "",
        "FOREST_OWNER_TOKEN": "forest379-synthetic-owner",
        "FOREST_WORKER_CONCURRENCY": "1",
        "TMPDIR": str(tmp_path / "tmp"),
        "MPLCONFIGDIR": str(tmp_path / "mpl"),
        "PYTHONPATH": str(ROOT),
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    Path(env["FOREST_DATA_DIR"]).mkdir()
    Path(env["TMPDIR"]).mkdir()
    Path(env["MPLCONFIGDIR"]).mkdir()
    result = subprocess.run(
        [sys.executable, "-c", scenario, str(ROOT), str(tmp_path)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
    )
    assert result.returncode == 0, result.stdout + result.stderr
