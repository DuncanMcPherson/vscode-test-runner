/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { coverageContext } from './coverageProvider';
import { FailingDeepStrictEqualAssertFixer } from './failingDeepStrictEqualAssertFixer';
import { readFile } from "./fileReader";
import { registerSnapshotUpdate } from './snapshot';
import { scanTestOutput } from './testOutputScanner';
import {
  TestCase,
  TestFile,
  clearFileDiagnostics,
  guessWorkspaceFolder,
  itemData,
} from './testTree';
import { AngularTestRunner, VSCodeTestRunner } from './vscodeTestRunner';

const TEST_FILE_PATTERN = 'src/**/*.{test,integrationTest,spec}.ts';
type TestRunner = "Karma" | "Jest" | "Angular" | undefined;

const getWorkspaceFolderForTestFile = (uri: vscode.Uri) =>
  (uri.path.endsWith('.test.ts') || uri.path.endsWith('.integrationTest.ts') || uri.path.endsWith('.spec.ts')) &&
  uri.path.includes('/src/')
    ? vscode.workspace.getWorkspaceFolder(uri)
    : undefined;

// const browserArgs: [name: string, arg: string][] = [
//   ['Chrome', 'chromium'],
//   ['Firefox', 'firefox'],
//   ['Webkit', 'webkit'],
// ];

const baseFileNames = [
  "package.json",
  "angular.json"
]

async function getRunnerName(d: vscode.TextDocument): Promise<TestRunner> {
  let fileName: string | undefined = undefined;
  for (const file of baseFileNames) {
    if (d.fileName.includes(file)) {
      fileName = d.fileName;
    }
  }

  if (fileName?.includes("karma") || fileName?.includes("jest") || fileName?.includes("angular")) {
    return fileName.includes("karma") ? "Karma" : fileName.includes("jest") ? "Jest" : "Angular";
  }

  if (fileName === undefined) {
    return undefined;
  }

  switch (fileName.split("\\").pop()) {
    case 'package.json':
      return await readPackageJson(d);
    case 'angular.json':
      return await readAngularJson(d);
  }
  return undefined;
}

async function readAngularJson(f: vscode.TextDocument): Promise<TestRunner> {
  const file = await readFile(f.uri);
  if (file === undefined) {
    return undefined;
  }

  const jsonValue = JSON.parse(file);
  const projects = jsonValue.projects;

  let testRunner: TestRunner = undefined;

  Object.keys(projects).forEach((key) => {
    if (testRunner === undefined) {
      const architectObject = projects[key].architect;
      if (architectObject === undefined) {
        return;
      }
      const testConfig = architectObject.test;
      if (testConfig === undefined) {
        return;
      }

      const builder: string = testConfig.builder;
      testRunner = builder.includes("karma") ? "Karma" : builder.includes("jest") ? "Jest" : undefined;
    }
  });

  return testRunner;
}

async function readPackageJson(f: vscode.TextDocument): Promise<TestRunner> {
  const file = await readFile(f.uri);
  if (file === undefined) {
    return undefined;
  }
  const jsonValue = JSON.parse(file)
  const scriptsDefs = jsonValue.scripts;
  if (scriptsDefs === undefined) {
    return undefined;
  }

  let testRunner: TestRunner = undefined;
  Object.keys(scriptsDefs).forEach((key) => {
    if (testRunner == undefined) {
      if (key.includes("test")) {
        testRunner = scriptsDefs[key].includes("karma") ? "Karma" : scriptsDefs[key].includes("jest") ? "Jest" : scriptsDefs[key].split(" ")[0] === "ng" ? "Angular" : undefined;
      }
    }
  });
  return testRunner;
}

type FileChangeEvent = { uri: vscode.Uri; removed: boolean };

export async function activate(context: vscode.ExtensionContext) {
  const ctrl = vscode.tests.createTestController('selfhost-test-controller', 'VS Code Tests');
  const fileChangedEmitter = new vscode.EventEmitter<FileChangeEvent>();

  ctrl.resolveHandler = async test => {
    if (!test) {
      context.subscriptions.push(await startWatchingWorkspace(ctrl, fileChangedEmitter));
      return;
    }

    const data = itemData.get(test);
    if (data instanceof TestFile) {
      // No need to watch this, updates will be triggered on file changes
      // either by the text document or file watcher.
      await data.updateFromDisk(ctrl, test);
    }
  };

  const createRunHandler = (
    runnerCtor: { new (folder: vscode.WorkspaceFolder, kind: vscode.TestRunProfileKind, continuous?: boolean,): VSCodeTestRunner },
    kind: vscode.TestRunProfileKind,
    args: string[] = []
  ) => {
    const doTestRun = async (
      req: vscode.TestRunRequest,
      cancellationToken: vscode.CancellationToken
    ) => {
      const folder = await guessWorkspaceFolder();
      if (!folder) {
        return;
      }

      const runner = new runnerCtor(folder, kind, req.continuous);
      const map = await getPendingTestMap(ctrl, req.include ?? gatherTestItems(ctrl.items));
      const task = ctrl.createTestRun(req);
      for (const test of map.values()) {
        task.enqueued(test);
      }

      let coverageDir: string | undefined;
      const currentArgs = args;

      return await scanTestOutput(
        map,
        task,
        kind === vscode.TestRunProfileKind.Debug
          ? await runner.debug(currentArgs, req.include)
          : await runner.run(currentArgs, req.include),
        coverageDir,
        cancellationToken
      );
    };

    return async (req: vscode.TestRunRequest, cancellationToken: vscode.CancellationToken) => {
      if (!req.continuous) {
        return doTestRun(req, cancellationToken);
      }

      const queuedFiles = new Set<string>();
      let debounced: NodeJS.Timer | undefined;

      const listener = fileChangedEmitter.event(({ uri, removed }) => {
        clearTimeout(debounced);

        if (req.include && !req.include.some(i => i.uri?.toString() === uri.toString())) {
          return;
        }

        if (removed) {
          queuedFiles.delete(uri.toString());
        } else {
          queuedFiles.add(uri.toString());
        }

        debounced = setTimeout(() => {
          const include =
            req.include?.filter(t => t.uri && queuedFiles.has(t.uri?.toString())) ??
            [...queuedFiles]
              .map(f => getOrCreateFile(ctrl, vscode.Uri.parse(f)))
              .filter((f): f is vscode.TestItem => !!f);
          queuedFiles.clear();

          doTestRun(
            new vscode.TestRunRequest(include, req.exclude, req.profile, true),
            cancellationToken
          );
        }, 1000);
      });

      cancellationToken.onCancellationRequested(() => {
        clearTimeout(debounced);
        listener.dispose();
      });
    };
  };

  let runnerName: TestRunner = undefined;

  for (const document of vscode.workspace.textDocuments) {
    if (runnerName === undefined) {
      const runner = await getRunnerName(document);
      if (!!runner && runner.length) {
        runnerName = runner;
      }
    }
    updateNodeForDocument(document);
  }

  function updateNodeForDocument(e: vscode.TextDocument) {
    const node = getOrCreateFile(ctrl, e.uri);
    const data = node && itemData.get(node);
    if (data instanceof TestFile) {
      data.updateFromContents(ctrl, e.getText(), node!);
    }
  }

  if (runnerName === undefined) {
    const k = await vscode.workspace.findFiles('*.confi?g?.m?(j|t)sx?');
    const d =(await vscode.workspace.findFiles('*.json')).concat(k)
    for (let i = 0; i < d.length; i++) {
      const u = d[i];
      const document = await vscode.workspace.openTextDocument(u)
      if (runnerName === undefined) {
        const runner = await getRunnerName(document);
        if (!!runner && runner.length) {
          runnerName = runner;
        }
      }
    }
  }

  // eslint-disable-next-line prefer-const
  let coverage: vscode.TestRunProfile = undefined!;
  switch (runnerName) {
    case "Angular":
      ctrl.createRunProfile(
        "Angular Tests",
        vscode.TestRunProfileKind.Run,
        createRunHandler(AngularTestRunner, vscode.TestRunProfileKind.Run),
        true,
        undefined,
        true
      );
      // TODO: Fix debugger profile
/*
      ctrl.createRunProfile(
        "Angular Debug Tests",
        vscode.TestRunProfileKind.Debug,
        createRunHandler(AngularTestRunner, vscode.TestRunProfileKind.Debug),
        true,
        undefined,
        true
      );
*/
/*
      // TODO: Fix Coverage profile
      coverage = ctrl.createRunProfile(
        "Coverage with Angular",
        vscode.TestRunProfileKind.Coverage,
        createRunHandler(AngularTestRunner, vscode.TestRunProfileKind.Coverage),
        true,
        undefined,
        true
      )
      */
    }
  if (coverage)
    coverage.loadDetailedCoverage = coverageContext.loadDetailedCoverage;
  // if (runnerName !== "Jest")
  //   for (const [name, arg] of browserArgs) {
  //     const cfg = ctrl.createRunProfile(
  //       `Run in ${name}`,
  //       vscode.TestRunProfileKind.Run,
  //       createRunHandler(BrowserTestRunner, vscode.TestRunProfileKind.Run, [' --browser', arg]),
  //       undefined,
  //       undefined,
  //       true
  //     );

  //     cfg.configureHandler = () => vscode.window.showInformationMessage(`Configuring ${name}`);

  //     ctrl.createRunProfile(
  //       `Debug in ${name}`,
  //       vscode.TestRunProfileKind.Debug,
  //       createRunHandler(BrowserTestRunner, vscode.TestRunProfileKind.Debug, [
  //         '--browser',
  //         arg,
  //         '--debug-browser',
  //       ]),
  //       undefined,
  //       undefined,
  //       true
  //     );
  //   }

  context.subscriptions.push(
    ctrl,
    fileChangedEmitter.event(({ uri, removed }) => {
      if (!removed) {
        const node = getOrCreateFile(ctrl, uri);
        if (node) {
          ctrl.invalidateTestResults();
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument(e => updateNodeForDocument(e.document)),
    registerSnapshotUpdate(ctrl),
    new FailingDeepStrictEqualAssertFixer()
  );
}

export function deactivate() {
  // no-op
}

function getOrCreateFile(
  controller: vscode.TestController,
  uri: vscode.Uri
): vscode.TestItem | undefined {
  const folder = getWorkspaceFolderForTestFile(uri);
  if (!folder) {
    return undefined;
  }

  const data = new TestFile(uri, folder);
  const existing = controller.items.get(data.getId());
  if (existing) {
    return existing;
  }

  const file = controller.createTestItem(data.getId(), data.getLabel(), uri);
  controller.items.add(file);
  file.canResolveChildren = true;
  itemData.set(file, data);

  return file;
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach(item => items.push(item));
  return items;
}

async function startWatchingWorkspace(
  controller: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<FileChangeEvent>
) {
  const workspaceFolder = await guessWorkspaceFolder();
  if (!workspaceFolder) {
    return new vscode.Disposable(() => undefined);
  }

  const pattern = new vscode.RelativePattern(workspaceFolder, TEST_FILE_PATTERN);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(uri => {
    getOrCreateFile(controller, uri);
    fileChangedEmitter.fire({ removed: false, uri });
  });
  watcher.onDidChange(uri => fileChangedEmitter.fire({ removed: false, uri }));
  watcher.onDidDelete(uri => {
    fileChangedEmitter.fire({ removed: true, uri });
    clearFileDiagnostics(uri);
    controller.items.delete(uri.toString());
  });

  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(controller, file);
  }

  return watcher;
}

async function getPendingTestMap(ctrl: vscode.TestController, tests: Iterable<vscode.TestItem>) {
  const queue = [tests];
  const titleMap = new Map<string, vscode.TestItem>();
  while (queue.length) {
    for (const item of queue.pop()!) {
      const data = itemData.get(item);
      if (data instanceof TestFile) {
        if (!data.hasBeenRead) {
          await data.updateFromDisk(ctrl, item);
        }
        queue.push(gatherTestItems(item.children));
      } else if (data instanceof TestCase) {
        titleMap.set(data.fullName, item);
      } else {
        queue.push(gatherTestItems(item.children));
      }
    }
  }

  return titleMap;
}
