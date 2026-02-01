import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { CrossFileSearchProvider } from '../crossFileSearchProvider';
import { TreeFilterConfig } from '../treeProvider';

suite('CrossFileSearchProvider', () => {
  const filesToCleanup: vscode.Uri[] = [];

  teardown(async () => {
    for (const file of filesToCleanup) {
      await vscode.workspace.fs.delete(file, { useTrash: false });
    }
    filesToCleanup.length = 0;
  });

  test('searchWorkspace finds matches across files', async function () {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return;
    }

    const fileA = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-a-${Date.now()}.arxml`));
    const fileB = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-b-${Date.now()}.arxml`));

    const contentA = `<?xml version="1.0" encoding="UTF-8"?>
<AUTOSAR>
  <ECUC>
    <SHORT-NAME>Alpha</SHORT-NAME>
  </ECUC>
</AUTOSAR>`;
    const contentB = `<?xml version="1.0" encoding="UTF-8"?>
<AUTOSAR>
  <ECUC>
    <SHORT-NAME>Beta</SHORT-NAME>
  </ECUC>
</AUTOSAR>`;

    await vscode.workspace.fs.writeFile(fileA, Buffer.from(contentA, 'utf8'));
    await vscode.workspace.fs.writeFile(fileB, Buffer.from(contentB, 'utf8'));
    filesToCleanup.push(fileA, fileB);

    const provider = new CrossFileSearchProvider();
    const filter: TreeFilterConfig = { mode: 'contains', name: 'Alpha' };
    const result = await provider.searchWorkspace(filter);

    const matchedFiles = result.files.map(entry => entry.file.fsPath);
    assert.ok(matchedFiles.includes(fileA.fsPath));
    assert.ok(!matchedFiles.includes(fileB.fsPath));
    assert.strictEqual(result.totalMatches, 1);
    provider.dispose();
  });

  test('searchWorkspace filters by element tag', async function () {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return;
    }

    const fileA = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-c-${Date.now()}.arxml`));

    const contentA = `<?xml version="1.0" encoding="UTF-8"?>
<AUTOSAR>
  <ECUC>
    <SHORT-NAME>Gamma</SHORT-NAME>
  </ECUC>
  <CONTAINER>
    <SHORT-NAME>Gamma</SHORT-NAME>
  </CONTAINER>
</AUTOSAR>`;

    await vscode.workspace.fs.writeFile(fileA, Buffer.from(contentA, 'utf8'));
    filesToCleanup.push(fileA);

    const provider = new CrossFileSearchProvider();
    const filter: TreeFilterConfig = { mode: 'contains', name: 'Gamma', element: 'ECUC' };
    const result = await provider.searchWorkspace(filter);

    assert.strictEqual(result.totalMatches, 1);
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].matches[0].element, 'ECUC');
    provider.dispose();
  });
});
