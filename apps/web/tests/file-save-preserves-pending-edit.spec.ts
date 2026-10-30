import { expect, test } from "@playwright/test";

test("a save response preserves edits made while the save is pending", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/projects", {
    data: { name: `Pending file save ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const path = "notes/pending-save.txt";
  const original = "original bytes\n";
  const saved = await request.put(`/api/projects/${project.id}/file`, {
    data: { path, content: original, expected_revision: 0 },
  });
  expect(saved.ok()).toBeTruthy();

  let releaseSave!: () => void;
  const saveCanContinue = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let notifySaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    notifySaveStarted = resolve;
  });
  let saveWasIntercepted = false;
  let saveResponse: ReturnType<typeof page.waitForResponse> | undefined;

  try {
    await page.route("**/api/projects/**/file*", async (route) => {
      const browserRequest = route.request();
      const requestUrl = new URL(browserRequest.url());
      if (
        browserRequest.method() === "PUT" &&
        requestUrl.pathname === `/api/projects/${project.id}/file`
      ) {
        saveWasIntercepted = true;
        notifySaveStarted();
        await saveCanContinue;
      }
      await route.continue();
    });

    await page.goto(`/projects/${project.id}/files`);
    await page
      .locator(".file-tree")
      .getByRole("button", { name: path })
      .click();
    const editor = page.locator(".file-editor .monaco-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("first saved version\n");
    await expect(page.locator(".file-toolbar")).toContainText("●");

    const pendingSaveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/projects/${project.id}/file`,
    );
    saveResponse = pendingSaveResponse;
    await page
      .locator(".file-toolbar")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await saveStarted;

    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText("later unsaved version\n");
    await expect(editor.locator(".view-lines")).toContainText(
      "later unsaved version",
    );
    await expect(page.locator(".file-toolbar")).toContainText("●");

    releaseSave();
    expect((await pendingSaveResponse).ok()).toBeTruthy();
    await expect(page.locator(".file-toolbar")).toContainText("●");

    const persistedBeforeReload = await request.get(
      `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`,
    );
    expect((await persistedBeforeReload.json()).content).toBe(
      "first saved version\n",
    );

    await page.reload();
    await page
      .locator(".file-tree")
      .getByRole("button", { name: path })
      .click();
    await expect(editor.locator(".view-lines")).toContainText(
      "later unsaved version",
    );
    await expect(page.locator(".file-toolbar")).toContainText("●");

    const persistedAfterReload = await request.get(
      `/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`,
    );
    expect((await persistedAfterReload.json()).content).toBe(
      "first saved version\n",
    );
  } finally {
    releaseSave();
    if (saveWasIntercepted && saveResponse) {
      await saveResponse.catch(() => undefined);
    }
    await page.unroute("**/api/projects/**/file*");
    await request.delete(`/api/projects/${project.id}`);
  }
});
