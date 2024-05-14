import { ChildProcessWithoutNullStreams } from "child_process";
import { AddressInfo, createServer } from "net";
import { spawn } from "node:child_process";
import * as path from "path";
import * as vscode from 'vscode';
import { readFile } from "./fileReader";
import { TestOutputScanner } from "./testOutputScanner";
import { TestCase, TestFile, TestSuite, itemData } from "./testTree";

const escapeRe = (s: string) => s.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');

const ATTACH_CONFIG_NAME = 'Attach to VS Code';
const DEBUG_TYPE = "pwa-chrome";

export abstract class VSCodeTestRunner {  constructor(protected readonly workspace: vscode.WorkspaceFolder, protected readonly runProfileKind: vscode.TestRunProfileKind, protected readonly continuousMode?: boolean) {}

  public abstract run(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>): Promise<TestOutputScanner>;
  public abstract debug(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>): Promise<TestOutputScanner>;
  protected abstract prepareArgs(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>): Promise<string[]>;

  protected findOpenPort() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, () => {
        const address = server.address() as AddressInfo;
        const port = address.port;
        server.close(() => {
          resolve(port);
        });
        server.on("error", (error: Error) => {
          reject(error);
        })
      })
    })
  }
}


export class AngularTestRunner extends VSCodeTestRunner {
  public async run(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>) {
    const args = await this.prepareArgs(baseArgs, filter);
    const cp = spawn(args.join(" "), {
      shell: true,
      stdio: "pipe",
      cwd: vscode.workspace.workspaceFolders![0].uri.fsPath
    }) as ChildProcessWithoutNullStreams;

    return new TestOutputScanner(cp, args);
  }

  public async debug(baseArgs: ReadonlyArray<string>, filter?: ReadonlyArray<vscode.TestItem>) {
    // const port = await this.findOpenPort();
    const baseConfig = vscode.workspace.getConfiguration("launch", this.workspace)
    .get<vscode.DebugConfiguration[]>("configurations", [])
    .find(c => c.name === ATTACH_CONFIG_NAME);

    if (!baseConfig) {
      throw new Error(`Could not find launch config ${ATTACH_CONFIG_NAME}`);
    }

    const server = this.createWaitServer();
    const args = [
      ...(await this.prepareArgs(baseArgs, filter)),
      // `--remote-debugging-port=${port}`
    ];
    const cp = spawn(args.join(" "), {
      cwd: this.workspace.uri.fsPath,
      shell: true,
      stdio: "pipe"
    });

    const factory = vscode.debug.registerDebugAdapterTrackerFactory(DEBUG_TYPE, {
            createDebugAdapterTracker(session) {
              if (!session.parentSession || session.parentSession !== rootSession) {
                return;
              }
      
              let initRequestId: number | undefined;
      
              return {
                onDidSendMessage(message) {
                  if (message.type === 'response' && message.request_seq === initRequestId) {
                    server.ready();
                  }
                },
                onWillReceiveMessage(message) {
                  if (initRequestId !== undefined) {
                    return;
                  }
      
                  if (message.command === 'launch' || message.command === 'attach') {
                    initRequestId = message.seq;
                  }
                },
              };
            },
          });
      
          // vscode.debug.startDebugging(this.workspace, { ...baseConfig, port });
      
          let exited = false;
          let rootSession: vscode.DebugSession | undefined;
          cp.once('exit', () => {
            exited = true;
            server.dispose();
            listener.dispose();
            factory.dispose();
      
            if (rootSession) {
              vscode.debug.stopDebugging(rootSession);
            }
          });
      
          const listener = vscode.debug.onDidStartDebugSession(s => {
            if (s.name === ATTACH_CONFIG_NAME && !rootSession) {
              if (exited) {
                vscode.debug.stopDebugging(rootSession);
              } else {
                rootSession = s;
              }
            }
          });
      
          return new TestOutputScanner(cp, args);
  }

  protected async prepareArgs(baseArgs: readonly string[], filter?: readonly vscode.TestItem[] | undefined): Promise<string[]> {
    let args = [
      ...this.getDefaultArgs(),
      "--",
      ...baseArgs,
      await this.getConfigName(),
      await this.getReporters(),
      this.continuousMode ? "--watch" : "--no-watch",
      "--browsers=ChromeHeadless",
      this.runProfileKind === vscode.TestRunProfileKind.Coverage ? "--code-coverage" : undefined
    ];

    args = args.filter(x => !!x);

    if (!filter) {
      return args as string[];
    }

    const grepRe: string[] = [];
    const runPaths = new Set<string>();
    const addTestFileRunPath = (data: TestFile) =>
      runPaths.add(
        path.relative(data.workspaceFolder.uri.fsPath, data.uri.fsPath).replace(/\\/g, '/')
      );

      for (const test of filter) {
        const data = itemData.get(test);
        if (data instanceof TestCase || data instanceof TestSuite) {
          grepRe.push(escapeRe(data.fullName) + (data instanceof TestCase ? '$' : ' '));
          for (let p = test.parent; p; p = p.parent) {
            const parentData = itemData.get(p);
            if (parentData instanceof TestFile) {
              addTestFileRunPath(parentData);
            }
          }
        } else if (data instanceof TestFile) {
          addTestFileRunPath(data);
        }
      }

      if (grepRe.length) {
        args.push('--grep', `/^(${grepRe.join('|')})/`);
      }

      if (runPaths.size) {
        args.push(...[...runPaths].flatMap(p => ['--run', p]));
      }

      return args as string[];
  }

  private createWaitServer() {
    const onReady = new vscode.EventEmitter<void>();
    let ready = false;

    const server = createServer(socket => {
      if (ready) {
        socket.end();
      } else {
        onReady.event(() => socket.end());
      }
    });

    server.listen(0);

    return {
      port: (server.address() as AddressInfo).port,
      ready: () => {
        ready = true;
        onReady.fire();
      },
      dispose: () => {
        server.close();
      },
    };
  }

  private getDefaultArgs(): string[] {
    return ["npm", "test"]
  }

  private async getConfigName(): Promise<string> {
    let files = await vscode.workspace.findFiles("karma.conf.ts");
    if (!files || !files.length) {
      files = await vscode.workspace.findFiles("karma.conf.js");
    }
    if (!files || !files.length) {
      return "";
    }

    const fileParts = files[0].path.split('/');
    const fileName = fileParts[fileParts.length - 1];

    const arg = `--karma-config=${fileName}`;
    return arg;
  }

  private async getReporters(): Promise<string> {
    let files = await vscode.workspace.findFiles("karma.conf.ts");
    if (!files || !files.length) {
      files = await vscode.workspace.findFiles("karma.conf.js");
    }
    if (!files || !files.length) {
      return "";
    }

    const content = await readFile(files[0]);
    if (!content || !content.length) {
      return "";
    }

    if (content.includes("reporters: ")) {
      const startIndex = content.indexOf("reporters: ");
      const endIndex = content.indexOf("]", startIndex);
      const arrString = content.slice(startIndex, endIndex);
      const reportersString = arrString.split('[')[1];
      const reportersNoQuotes = reportersString.split(', ').map(rep => {
        rep = rep.replace("'", '');
        rep = rep.replace("'", '');
        return rep.trim()
      })
      return `--reporters=${reportersNoQuotes.join(',')}`;
    }

    return "";
  }
}
// export abstract class VSCodeTestRunner {
//   private prepareArguments(
//     baseArgs: ReadonlyArray<string>,
//     filter?: ReadonlyArray<vscode.TestItem>
//   ) {
//     const args = [...this.getDefaultArgs(), ...baseArgs,'--reporter', 'full-json-stream'];
//     if (!filter) {
//       return args;
//     }

//     const grepRe: string[] = [];
//     const runPaths = new Set<string>();
//     const addTestFileRunPath = (data: TestFile) =>
//       runPaths.add(
//         path.relative(data.workspaceFolder.uri.fsPath, data.uri.fsPath).replace(/\\/g, '/')
//       );

//     for (const test of filter) {
//       const data = itemData.get(test);
//       if (data instanceof TestCase || data instanceof TestSuite) {
//         grepRe.push(escapeRe(data.fullName) + (data instanceof TestCase ? '$' : ' '));
//         for (let p = test.parent; p; p = p.parent) {
//           const parentData = itemData.get(p);
//           if (parentData instanceof TestFile) {
//             addTestFileRunPath(parentData);
//           }
//         }
//       } else if (data instanceof TestFile) {
//         addTestFileRunPath(data);
//       }
//     }

//     if (grepRe.length) {
//       args.push('--grep', `/^(${grepRe.join('|')})/`);
//     }

//     if (runPaths.size) {
//       args.push(...[...runPaths].flatMap(p => ['--run', p]));
//     }

//     return args;
//   }

//   protected abstract getDefaultArgs(): string[];

//   protected abstract binaryPath(): Promise<string>;

//   protected async readProductJson() {
//     const projectJson = await fs.readFile(
//       path.join(this.repoLocation.uri.fsPath, 'product.json'),
//       'utf-8'
//     );
//     try {
//       return JSON.parse(projectJson);
//     } catch (e) {
//       throw new Error(`Error parsing product.json: ${(e as Error).message}`);
//     }
//   }

//   protected getEnvironment(): NodeJS.ProcessEnv {
//     return {
//       ...process.env,
//       ELECTRON_RUN_AS_NODE: undefined,
//       ELECTRON_ENABLE_LOGGING: '1',
//     };
//   }

//   private createWaitServer() {
//     const onReady = new vscode.EventEmitter<void>();
//     let ready = false;

//     const server = createServer(socket => {
//       if (ready) {
//         socket.end();
//       } else {
//         onReady.event(() => socket.end());
//       }
//     });

//     server.listen(0);

//     return {
//       port: (server.address() as AddressInfo).port,
//       ready: () => {
//         ready = true;
//         onReady.fire();
//       },
//       dispose: () => {
//         server.close();
//       },
//     };
//   }
// }

// export class BrowserTestRunner extends VSCodeTestRunner {
//   /** @override */
//   protected binaryPath(): Promise<string> {
//     return Promise.resolve(process.execPath);
//   }

//   /** @override */
//   protected getEnvironment() {
//     return {
//       ...super.getEnvironment(),
//       ELECTRON_RUN_AS_NODE: '1',
//     };
//   }

//   /** @override */
//   protected getDefaultArgs() {
//     return [TEST_BROWSER_SCRIPT_PATH];
//   }
// }

// export class AngularTestRunner extends VSCodeTestRunner {
//   protected binaryPath(): Promise<string> {
//     return Promise.resolve(process.execPath)
//   }

//   protected getDefaultArgs(): string[] {
//     return ["ng test"]
//   }
// }

// export class WindowsTestRunner extends VSCodeTestRunner {
//   /** @override */
//   protected async binaryPath() {
//     const { nameShort } = await this.readProductJson();
//     return path.join(this.repoLocation.uri.fsPath, `.build/electron/${nameShort}.exe`);
//   }

//   /** @override */
//   protected getDefaultArgs() {
//     return [TEST_ELECTRON_SCRIPT_PATH];
//   }
// }

// export class PosixTestRunner extends VSCodeTestRunner {
//   /** @override */
//   protected async binaryPath() {
//     const { applicationName } = await this.readProductJson();
//     return path.join(this.repoLocation.uri.fsPath, `.build/electron/${applicationName}`);
//   }

//   /** @override */
//   protected getDefaultArgs() {
//     return [TEST_ELECTRON_SCRIPT_PATH];
//   }
// }

// export class DarwinTestRunner extends PosixTestRunner {
//   /** @override */
//   protected getDefaultArgs() {
//     return [
//       TEST_ELECTRON_SCRIPT_PATH,
//       '--no-sandbox',
//       '--disable-dev-shm-usage',
//       '--use-gl=swiftshader',
//     ];
//   }

//   /** @override */
//   protected async binaryPath() {
//     const { nameLong } = await this.readProductJson();
//     return path.join(
//       this.repoLocation.uri.fsPath,
//       `.build/electron/${nameLong}.app/Contents/MacOS/Electron`
//     );
//   }
// }

// export const PlatformTestRunner =
//   process.platform === 'win32'
//     ? WindowsTestRunner
//     : process.platform === 'darwin'
//     ? DarwinTestRunner
//     : PosixTestRunner;
