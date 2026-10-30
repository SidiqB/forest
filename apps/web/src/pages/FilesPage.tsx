import { SourceExplorer } from "../progress/SourceExplorer";
import { createFileSelectionGuard } from "../fileSelection";
import {
  orderFileTreeEntries,
  visibleFileTreeEntries,
} from "../files/fileTree";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import {
  Plus,
  Search,
  Download,
  Trash2,
  Pencil,
  RefreshCw,
  FileText,
  Upload,
  Folder,
  File,
  Save,
  Table2,
  GitCompare,
} from "lucide-react";
import { api, download } from "../api";
import type { Json } from "../api";
import {
  useUI,
  useLoad,
  Button,
  IconButton,
  Modal,
  Field,
  Empty,
  ErrorBox,
  PageHeading,
  Loading,
} from "../ui";
import { CodeEditor, PDFViewer } from "../editors";

export function FilesPage() {
  const { id } = useParams();
  const { t, action } = useUI();
  type FilePage = {
    files: Json[];
    has_more: boolean;
    next_cursor: string | null;
  };
  const {
    data,
    error,
    reload: reloadFirstPage,
  } = useLoad<FilePage>(`/projects/${id}/files?limit=500`, {
    files: [],
    has_more: false,
    next_cursor: null,
  });
  const [pageData, setPageData] = useState<{
    projectId: string;
    page: FilePage;
  } | null>(null);
  const pageRequestGeneration = useRef(0);
  const activeProjectId = useRef(id);
  activeProjectId.current = id;
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const pageCursorRef = useRef<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const [changingPage, setChangingPage] = useState(false);
  const changingPageRef = useRef(false);
  const deferredPageRefresh = useRef(false);
  const pageRefreshAttempt = useRef<{
    generation: number;
    projectId: string;
  } | null>(null);
  const [pageFailure, setPageFailure] = useState<{
    projectId: string;
    message: string;
  } | null>(null);
  const filePage = pageData && pageData.projectId === id ? pageData.page : data;
  const reload = useCallback(async () => {
    pageRequestGeneration.current += 1;
    pageCursorRef.current = null;
    changingPageRef.current = false;
    deferredPageRefresh.current = false;
    pageRefreshAttempt.current = null;
    setChangingPage(false);
    setPageData(null);
    setPageCursor(null);
    setCursorHistory([]);
    setPageFailure(null);
    await reloadFirstPage();
  }, [reloadFirstPage]);
  const refreshCurrentPage = useCallback(async (): Promise<void> => {
    if (!id || activeProjectId.current !== id) return;
    if (changingPageRef.current) {
      deferredPageRefresh.current = true;
      return;
    }
    if (
      pageRefreshAttempt.current?.generation === pageRequestGeneration.current
    ) {
      deferredPageRefresh.current = true;
      return;
    }
    const cursor = pageCursorRef.current;
    const generation = ++pageRequestGeneration.current;
    const attempt = { generation, projectId: id };
    pageRefreshAttempt.current = attempt;
    try {
      const query = `?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await api<FilePage>(`/projects/${id}/files${query}`);
      if (
        activeProjectId.current !== id ||
        pageRequestGeneration.current !== generation ||
        pageCursorRef.current !== cursor
      )
        return;
      setPageData({ projectId: id, page });
      setPageFailure(null);
    } catch (failure) {
      if (
        activeProjectId.current === id &&
        pageRequestGeneration.current === generation
      )
        setPageFailure({ projectId: id, message: (failure as Error).message });
    } finally {
      if (pageRefreshAttempt.current === attempt)
        pageRefreshAttempt.current = null;
      if (
        activeProjectId.current === id &&
        pageRequestGeneration.current === generation &&
        deferredPageRefresh.current &&
        !changingPageRef.current
      ) {
        deferredPageRefresh.current = false;
        void refreshCurrentPage();
      }
    }
  }, [id]);
  useEffect(() => {
    const refreshFiles = () => void refreshCurrentPage();
    window.addEventListener("forest-refresh", refreshFiles);
    return () => window.removeEventListener("forest-refresh", refreshFiles);
  }, [refreshCurrentPage]);
  useEffect(() => {
    pageRequestGeneration.current += 1;
    pageCursorRef.current = null;
    changingPageRef.current = false;
    deferredPageRefresh.current = false;
    pageRefreshAttempt.current = null;
    setPageData(null);
    setPageCursor(null);
    setCursorHistory([]);
    setChangingPage(false);
    setPageFailure(null);
    return () => {
      pageRequestGeneration.current += 1;
    };
  }, [id]);
  const changeFilePage = async (direction: "next" | "previous") => {
    if (changingPageRef.current) return;
    const nextCursor =
      direction === "next"
        ? filePage.next_cursor
        : (cursorHistory.at(-1) ?? null);
    if (direction === "next" && (!filePage.has_more || !nextCursor)) return;
    if (direction === "previous" && !cursorHistory.length) return;
    const requestProjectId = id;
    const requestGeneration = ++pageRequestGeneration.current;
    changingPageRef.current = true;
    setChangingPage(true);
    setPageFailure(null);
    try {
      const query = `?limit=500${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`;
      const nextPage = await api<FilePage>(
        `/projects/${requestProjectId}/files${query}`,
      );
      if (
        pageRequestGeneration.current !== requestGeneration ||
        activeProjectId.current !== requestProjectId
      )
        return;
      if (direction === "next")
        setCursorHistory((history) => [...history, pageCursor]);
      else setCursorHistory((history) => history.slice(0, -1));
      pageCursorRef.current = nextCursor;
      setPageCursor(nextCursor);
      setPageData({ projectId: requestProjectId!, page: nextPage });
    } catch (failure) {
      if (
        activeProjectId.current === requestProjectId &&
        pageRequestGeneration.current === requestGeneration
      )
        setPageFailure({
          projectId: requestProjectId!,
          message: (failure as Error).message,
        });
    } finally {
      if (
        pageRequestGeneration.current === requestGeneration &&
        activeProjectId.current === requestProjectId
      ) {
        changingPageRef.current = false;
        setChangingPage(false);
        if (deferredPageRefresh.current) {
          deferredPageRefresh.current = false;
          void refreshCurrentPage();
        }
      }
    }
  };
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const contentRef = useRef(content);
  const updateContent = (value: string) => {
    contentRef.current = value;
    setContent(value);
  };
  const [original, setOriginal] = useState("");
  const [revision, setRevision] = useState<number | undefined>();
  const [loadedPath, setLoadedPath] = useState("");
  const [loadError, setLoadError] = useState("");
  const fileSelection = useRef(createFileSelectionGuard()).current;
  const fileReadGeneration = useRef(0);
  const draftVersion = useRef(0);
  const [filter, setFilter] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(
    () => new Set(),
  );
  const [newFile, setNewFile] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [diff, setDiff] = useState(false);
  const [tablePreview, setTablePreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<
    | { kind: "changed"; content: string; revision: number }
    | { kind: "missing"; path: string }
    | null
  >(null);
  const fileDraftKey = (relativePath: string) =>
    `forest-file-draft:${id}:${relativePath}`;
  const loadTextFile = async (
    relativePath: string,
    isStale?: () => boolean,
  ) => {
    const saved = await api(
      `/projects/${id}/file?path=${encodeURIComponent(relativePath)}`,
    );
    if (isStale?.()) return;
    const key = fileDraftKey(relativePath);
    let draft: Json | null = null;
    try {
      draft = JSON.parse(sessionStorage.getItem(key) || "null");
    } catch {
      sessionStorage.removeItem(key);
    }
    if (isStale?.()) return;
    if (
      draft &&
      typeof draft.content === "string" &&
      draft.content !== draft.original
    ) {
      updateContent(draft.content);
      setOriginal(
        typeof draft.original === "string" ? draft.original : saved.content,
      );
      setRevision(
        typeof draft.revision === "number" ? draft.revision : saved.revision,
      );
      setDirty(true);
      return;
    }
    sessionStorage.removeItem(key);
    updateContent(saved.content);
    setOriginal(saved.content);
    setRevision(saved.revision);
    setDirty(false);
  };
  const changeContent = (value: string) => {
    updateContent(value);
    setDirty(value !== original);
    const key = fileDraftKey(path);
    if (value === original) sessionStorage.removeItem(key);
    else
      sessionStorage.setItem(
        key,
        JSON.stringify({ content: value, original, revision }),
      );
  };
  const extension = path.split(".").pop()?.toLowerCase();
  const image = ["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(
    extension || "",
  );
  const binary = ["parquet", "zip", "pkl", "npy", "npz"].includes(
    extension || "",
  );
  const orderedFiles = useMemo(
    () =>
      orderFileTreeEntries(
        filePage.files as Array<
          Json & { path: string; is_dir?: boolean; size: number }
        >,
      ),
    [filePage.files],
  );
  const visibleFiles = visibleFileTreeEntries(
    orderedFiles,
    filter,
    collapsedDirectories,
  );
  const url = `/api/projects/${id}/download?path=${encodeURIComponent(path)}`;
  const open = async (p: string) => {
    if (dirty && !confirm(t("放弃未保存修改？", "Discard unsaved changes?")))
      return;
    if (dirty && path) sessionStorage.removeItem(fileDraftKey(path));
    const selection = fileSelection.select(p);
    fileReadGeneration.current += 1;
    setPath(p);
    setDiff(false);
    setTablePreview(false);
    setDirty(false);
    setLoadedPath("");
    setLoadError("");
    updateContent("");
    setOriginal("");
    setRevision(undefined);
    if (/\.(csv|tsv)$/i.test(p)) {
      setTablePreview(true);
      setLoadedPath(p);
      return;
    }
    if (!/\.(pdf|png|jpe?g|svg|webp|gif|parquet|zip|pkl|npy|npz)$/i.test(p)) {
      try {
        await loadTextFile(p, () => !fileSelection.isCurrent(selection));
        if (!fileSelection.isCurrent(selection)) return;
        setLoadedPath(p);
      } catch (error) {
        if (!fileSelection.isCurrent(selection)) return;
        setLoadError((error as Error).message);
        throw error;
      }
    } else {
      setLoadedPath(p);
    }
  };
  const save = async (force = false) => {
    const selection = fileSelection.current();
    const targetPath = path;
    const savedContent = content;
    const savedRevision = revision;
    if (
      !targetPath ||
      selection.path !== targetPath ||
      loadedPath !== targetPath ||
      savedRevision === undefined
    ) {
      throw new Error(
        "Wait for the selected file to finish loading before saving.",
      );
    }
    try {
      const r = await api(
        `/projects/${id}/file?path=${encodeURIComponent(targetPath)}`,
        "PUT",
        {
          path: targetPath,
          content: savedContent,
          ...(force ? {} : { expected_revision: savedRevision }),
        },
      );
      if (!fileSelection.isCurrent(selection)) {
        await reload();
        return;
      }
      setRevision(r.revision);
      setOriginal(savedContent);
      const latestContent = contentRef.current;
      setDirty(latestContent !== savedContent);
      setConflict(null);
      const draftKey = fileDraftKey(targetPath);
      if (latestContent === savedContent) {
        sessionStorage.removeItem(draftKey);
      } else {
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({
            content: latestContent,
            original: savedContent,
            revision: r.revision,
          }),
        );
      }
      await reload();
    } catch (e) {
      if ((e as any).status === 409) {
        try {
          const latest = await api(
            `/projects/${id}/file?path=${encodeURIComponent(targetPath)}`,
          );
          if (!fileSelection.isCurrent(selection)) return;
          setConflict({
            kind: "changed",
            content: latest.content,
            revision: latest.revision,
          });
        } catch (readError) {
          if (!fileSelection.isCurrent(selection)) return;
          if ((readError as any).status !== 404) throw readError;
          setConflict({ kind: "missing", path: targetPath });
        }
        return;
      }
      throw e;
    }
  };
  const upload = async (files: FileList | File[]) => {
    const selected = [...files].map((file) => {
      const relativePath = file.webkitRelativePath || file.name;
      const parts = relativePath.split("/");
      const safeParts = parts.every(
        (part) => part && part !== "." && part !== "..",
      );
      const path = `uploads/${safeParts ? relativePath : file.name}`;
      return {
        file,
        path,
        directory: path.split("/").slice(0, -1).join("/"),
      };
    });
    const existing = new Set<string>();
    const destinations = [...new Set(selected.map((item) => item.path))];
    for (let offset = 0; offset < destinations.length; offset += 1000) {
      const result = await api<{ existing: string[]; directories: string[] }>(
        `/projects/${id}/files/existing`,
        "POST",
        { paths: destinations.slice(offset, offset + 1000) },
      );
      if (result.directories.length) {
        throw new Error(
          t(
            `这些上传目标是目录，不能用文件替换：${result.directories.slice(0, 5).join(", ")}`,
            `These upload destinations are directories and cannot be replaced by files: ${result.directories.slice(0, 5).join(", ")}`,
          ),
        );
      }
      result.existing.forEach((item) => existing.add(item));
    }
    const seen = new Set<string>();
    const conflicts = new Set<string>();
    for (const item of selected) {
      if (existing.has(item.path) || seen.has(item.path))
        conflicts.add(item.path);
      seen.add(item.path);
    }
    if (conflicts.size) {
      const paths = [...conflicts];
      const listed = paths.slice(0, 5).join(", ");
      const more = paths.length > 5 ? ` (+${paths.length - 5})` : "";
      if (
        !confirm(
          t(
            `这些目标路径已存在或在所选文件中重复：${listed}${more}。继续将覆盖目标内容；同一目标选了多个文件时保留最后一个。继续吗？`,
            `These upload destinations already exist or repeat in this selection: ${listed}${more}. Continuing replaces their contents; if multiple selected files share a destination, the last one is kept. Continue?`,
          ),
        )
      )
        return;
    }
    const uploaded: string[] = [];
    for (const item of selected) {
      const body = new FormData();
      body.append("file", item.file);
      const overwrite = conflicts.has(item.path);
      try {
        await api(
          `/projects/${id}/upload?directory=${encodeURIComponent(item.directory)}&overwrite=${overwrite}`,
          "POST",
          body,
        );
        uploaded.push(item.path);
      } catch (error) {
        await reload();
        if (!uploaded.length) throw error;
        const names = uploaded.slice(0, 5).join(", ");
        const more = uploaded.length > 5 ? ` (+${uploaded.length - 5})` : "";
        throw new Error(
          t(
            `已上传 ${uploaded.length} 个文件（${names}${more}）；${item.path} 上传失败。文件列表已刷新。`,
            `Uploaded ${uploaded.length} file(s) (${names}${more}); ${item.path} failed. The file list has been refreshed.`,
          ),
        );
      }
    }
    await reload();
  };
  return (
    <div
      className="page files-page"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void action(() => upload(e.dataTransfer.files));
      }}
    >
      <PageHeading
        title={t("文件", "Files")}
        actions={
          <>
            <label className="button upload-button">
              <Upload size={15} />
              {t("上传文件", "Upload")}
              <input
                type="file"
                multiple
                onChange={(e) => {
                  if (e.target.files)
                    void action(() => upload(e.target.files!));
                }}
              />
            </label>
            <Button className="primary" onClick={() => setNewFile(true)}>
              <Plus size={15} />
              {t("新建文件", "New file")}
            </Button>
          </>
        }
      />
      <SourceExplorer key={id} projectId={id!} />
      <ErrorBox
        error={
          pageFailure && pageFailure.projectId === id
            ? pageFailure.message
            : error
        }
        retry={
          pageFailure?.projectId === id
            ? () => void refreshCurrentPage()
            : reload
        }
      />
      <div className="file-workbench">
        <aside className="file-tree">
          <label className="search-input">
            <Search size={14} />
            <input
              aria-label={t("查找文件…", "Find files…")}
              placeholder={t("查找文件…", "Find files…")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <div className="file-tree-list">
            {visibleFiles.map((f) => (
              <button
                key={f.path}
                className={`${path === f.path ? "active" : ""}${f.is_dir ? " directory" : ""}`}
                aria-expanded={
                  f.is_dir ? !collapsedDirectories.has(f.path) : undefined
                }
                style={{
                  paddingLeft: `${15 + (f.path.split("/").length - 1) * 14}px`,
                }}
                onClick={() => {
                  if (f.is_dir) {
                    setCollapsedDirectories((current) => {
                      const next = new Set(current);
                      if (next.has(f.path)) next.delete(f.path);
                      else next.add(f.path);
                      return next;
                    });
                  } else void action(() => open(f.path));
                }}
                title={f.path}
              >
                {f.is_dir ? <Folder size={15} /> : <File size={14} />}
                <span>{f.path}</span>
                <small>
                  {f.is_dir
                    ? ""
                    : f.size < 1024
                      ? `${f.size} B`
                      : `${(f.size / 1024).toFixed(1)} K`}
                </small>
              </button>
            ))}
          </div>
          {!filePage.files.length && (
            <Empty title={t("暂无文件", "No files")} />
          )}
          {(cursorHistory.length > 0 || filePage.has_more) && (
            <div className="file-tree-pagination">
              <small>
                {t(
                  `第 ${cursorHistory.length + 1} 页 · 搜索仅限本页`,
                  `Page ${cursorHistory.length + 1} · Search covers this page only`,
                )}
              </small>
              <div>
                <Button
                  disabled={!cursorHistory.length || changingPage}
                  onClick={() => void action(() => changeFilePage("previous"))}
                >
                  {t("上一页", "Previous")}
                </Button>
                <Button
                  disabled={!filePage.has_more || changingPage}
                  onClick={() => void action(() => changeFilePage("next"))}
                >
                  {changingPage
                    ? t("载入中…", "Loading…")
                    : t("下一页", "Next")}
                </Button>
              </div>
            </div>
          )}
        </aside>
        <section className="file-editor">
          {path ? (
            <>
              <div className="file-toolbar">
                <span>
                  <FileText size={15} />
                  {path}
                  {dirty ? " ●" : ""}
                </span>
                <div className="toolbar-spacer" />
                {["csv", "tsv"].includes(extension || "") && (
                  <IconButton
                    label={t(
                      "切换已保存数据表预览",
                      "Toggle saved table preview",
                    )}
                    onClick={() => {
                      if (tablePreview) {
                        if (dirty) {
                          setTablePreview(false);
                        } else {
                          void action(async () => {
                            const selection = fileSelection.current();
                            const readGeneration = ++fileReadGeneration.current;
                            setLoadedPath("");
                            setLoadError("");
                            try {
                              await loadTextFile(
                                path,
                                () =>
                                  !fileSelection.isCurrent(selection) ||
                                  fileReadGeneration.current !== readGeneration,
                              );
                              if (
                                !fileSelection.isCurrent(selection) ||
                                fileReadGeneration.current !== readGeneration
                              )
                                return;
                              setLoadedPath(path);
                              setTablePreview(false);
                            } catch (error) {
                              if (
                                fileSelection.isCurrent(selection) &&
                                fileReadGeneration.current === readGeneration
                              )
                                setLoadError((error as Error).message);
                              throw error;
                            }
                          });
                        }
                      } else setTablePreview(true);
                    }}
                  >
                    <Table2 size={15} />
                  </IconButton>
                )}
                {!image && !binary && !tablePreview && extension !== "pdf" && (
                  <>
                    <IconButton
                      label={t("比较编辑差异", "Compare changes")}
                      onClick={() => setDiff(!diff)}
                    >
                      <GitCompare size={15} />
                    </IconButton>
                    <Button
                      disabled={loadedPath !== path || revision === undefined}
                      onClick={() => action(() => save())}
                    >
                      <Save size={14} />
                      {t("保存", "Save")}
                    </Button>
                  </>
                )}
                <IconButton
                  label={t("下载", "Download")}
                  onClick={() =>
                    action(() =>
                      download(
                        `/projects/${id}/download?path=${encodeURIComponent(path)}`,
                        undefined,
                        path.split("/").pop(),
                      ),
                    )
                  }
                >
                  <Download size={15} />
                </IconButton>
                <IconButton
                  label={t("重命名", "Rename")}
                  disabled={loadedPath !== path}
                  onClick={() => {
                    const next = prompt(t("新文件路径", "New file path"), path);
                    if (next && next !== path)
                      void action(async () => {
                        const selection = fileSelection.current();
                        const targetPath = path;
                        const renamed = await api(
                          `/projects/${id}/file/rename`,
                          "POST",
                          { path: targetPath, new_path: next },
                        );
                        if (!fileSelection.isCurrent(selection)) {
                          await reload();
                          return;
                        }
                        fileSelection.select(next);
                        setPath(next);
                        setRevision(renamed.revision);
                        setLoadedPath(next);
                        await reload();
                      });
                  }}
                >
                  <Pencil size={15} />
                </IconButton>
                <IconButton
                  label={t("删除文件", "Delete file")}
                  onClick={() => {
                    if (confirm(t(`删除 ${path}？`, `Delete ${path}?`)))
                      void action(async () => {
                        const selection = fileSelection.current();
                        const targetPath = path;
                        await api(
                          `/projects/${id}/file?path=${encodeURIComponent(targetPath)}`,
                          "DELETE",
                        );
                        if (!fileSelection.isCurrent(selection)) {
                          await reload();
                          return;
                        }
                        fileSelection.select("");
                        setPath("");
                        updateContent("");
                        setOriginal("");
                        setRevision(undefined);
                        setLoadedPath("");
                        setDirty(false);
                        await reload();
                      });
                  }}
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
              {loadedPath !== path ? (
                loadError ? (
                  <ErrorBox
                    error={loadError}
                    retry={() => void action(() => open(path))}
                  />
                ) : (
                  <p role="status">{t("正在加载文件…", "Loading file…")}</p>
                )
              ) : extension === "pdf" ? (
                <PDFViewer url={url} />
              ) : image ? (
                <div className="file-image">
                  <img src={url} alt={path} />
                </div>
              ) : extension === "parquet" ||
                (["csv", "tsv"].includes(extension || "") && tablePreview) ? (
                <FileTablePreview
                  key={`${path}-${revision}`}
                  projectId={id!}
                  path={path}
                />
              ) : binary ? (
                <Empty
                  title={t("无法预览", "Preview unavailable")}
                  action={
                    <a className="button" href={url} download>
                      <Download size={15} />
                      {t("下载文件", "Download file")}
                    </a>
                  }
                />
              ) : diff ? (
                <div className="diff-columns">
                  <div>
                    <span>{t("保存的内容", "Saved content")}</span>
                    <CodeEditor
                      value={original}
                      readOnly
                      language={extension}
                    />
                  </div>
                  <div>
                    <span>{t("当前编辑", "Current edit")}</span>
                    <CodeEditor
                      value={content}
                      onChange={(v) => {
                        draftVersion.current += 1;
                        changeContent(v);
                      }}
                      language={extension}
                    />
                  </div>
                </div>
              ) : (
                <CodeEditor
                  value={content}
                  onChange={(v) => {
                    draftVersion.current += 1;
                    changeContent(v);
                  }}
                  language={
                    extension === "py"
                      ? "python"
                      : extension === "tex"
                        ? "latex"
                        : extension === "md"
                          ? "markdown"
                          : extension === "ts"
                            ? "typescript"
                            : extension
                  }
                />
              )}
            </>
          ) : (
            <Empty
              icon={<Folder size={30} />}
              title={t("未选择文件", "No file selected")}
            />
          )}
        </section>
      </div>
      {newFile && (
        <Modal
          title={t("新建文件", "Create file")}
          onClose={() => setNewFile(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await api(
                  `/projects/${id}/file?path=${encodeURIComponent(newPath)}`,
                  "PUT",
                  { path: newPath, content: "", create_only: true },
                );
                await reload();
                await open(newPath);
                setNewFile(false);
                setNewPath("");
              });
            }}
          >
            <Field label={t("项目内路径", "Path within project")}>
              <input
                required
                autoFocus
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="experiments/method.py"
              />
            </Field>
            <div className="modal-actions">
              <Button className="primary" type="submit">
                {t("创建", "Create")}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {conflict && (
        <Modal
          wide
          title={
            conflict.kind === "missing"
              ? t("文件已被删除或改名", "File deleted or renamed")
              : t("文件已被另一处修改", "File changed elsewhere")
          }
          onClose={() => setConflict(null)}
        >
          <p>
            {conflict.kind === "missing"
              ? t(
                  "此路径已不存在。你的草稿仍保留在编辑器中，可以另存到新路径。",
                  "This path no longer exists. Your draft remains in the editor and can be saved to a new path.",
                )
              : t(
                  "比较服务端内容，再选择覆盖或另存；你的当前编辑保留在编辑器中。",
                  "Compare the server content, then overwrite or save separately. Your current edit remains in the editor.",
                )}
          </p>
          {conflict.kind === "changed" && (
            <pre className="json-view">{conflict.content}</pre>
          )}
          <div className="modal-actions">
            {conflict.kind === "changed" && (
              <>
                <Button
                  onClick={() => {
                    setOriginal(conflict.content);
                    setRevision(conflict.revision);
                    setConflict(null);
                    setDiff(true);
                  }}
                >
                  {t("在差异视图中合并", "Merge in comparison view")}
                </Button>
                <Button onClick={() => action(() => save(true))}>
                  {t("用当前内容覆盖", "Overwrite with current content")}
                </Button>
              </>
            )}
            <Button
              className="primary"
              onClick={() => {
                const next = prompt(
                  t("另存路径", "Save as path"),
                  `${path}.copy`,
                );
                if (next)
                  void action(async () => {
                    const selection = fileSelection.current();
                    const savedContent = content;
                    const savedDraftVersion = draftVersion.current;
                    const saved = await api(
                      `/projects/${id}/file?path=${encodeURIComponent(next)}`,
                      "PUT",
                      { path: next, content: savedContent },
                    );
                    if (!fileSelection.isCurrent(selection)) {
                      await reload();
                      return;
                    }
                    fileSelection.select(next);
                    setConflict(null);
                    setPath(next);
                    setRevision(saved.revision);
                    setOriginal(savedContent);
                    setLoadedPath(next);
                    setDirty(draftVersion.current !== savedDraftVersion);
                    await reload();
                  });
              }}
            >
              {t("另存为", "Save as")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FileTablePreview({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const { t } = useUI();
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useLoad<Json>(
    `/projects/${projectId}/file/preview?path=${encodeURIComponent(path)}&offset=${offset}&limit=50`,
    null!,
  );
  return (
    <div className="file-table-preview">
      <div className="file-table-heading">
        <span>{t("已保存文件中的实际数据", "Saved file preview")}</span>
        <Button onClick={reload}>
          <RefreshCw size={13} />
          {t("重新读取", "Reload")}
        </Button>
      </div>
      <ErrorBox error={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : (
        data && (
          <>
            {data.truncated_columns && (
              <div className="file-table-heading" role="status">
                {t(
                  `仅显示 ${data.column_count} 列中的前 ${data.columns.length} 列；其余列未显示。下载原始文件可查看全部列。`,
                  `Showing the first ${data.columns.length} of ${data.column_count} columns; remaining columns are omitted. Download the original file to view all columns.`,
                )}
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {data.columns.map((column: string) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row: Json, index: number) => (
                    <tr key={index}>
                      {data.columns.map((column: string) => (
                        <td key={column}>
                          {row[column] === null ? (
                            <span className="missing">null</span>
                          ) : typeof row[column] === "object" ? (
                            JSON.stringify(row[column])
                          ) : (
                            String(row[column] ?? "")
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="raw-pagination">
              <Button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                {t("上一页", "Previous")}
              </Button>
              <span>
                {Math.min(offset + 1, data.total)}–
                {Math.min(offset + 50, data.total)} / {data.total}
              </span>
              <Button
                disabled={offset + 50 >= data.total}
                onClick={() => setOffset(offset + 50)}
              >
                {t("下一页", "Next")}
              </Button>
            </div>
          </>
        )
      )}
    </div>
  );
}
