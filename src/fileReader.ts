import * as vscode from "vscode";

export async function readFile(filePath: vscode.Uri): Promise<string | undefined> {
    try {
        const textDecoder = new TextDecoder("utf-8");
        const raw = await vscode.workspace.fs.readFile(filePath);
        return textDecoder.decode(raw)
    } catch (err) {
        console.warn(`An error ocurred reading file: ${filePath.fsPath}`, err);
        return undefined;
    }
}