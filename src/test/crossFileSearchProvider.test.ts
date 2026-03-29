import * as assert from 'assert';
import * as fs from 'fs';
import { once } from 'events';
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
    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
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
    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
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

  test('searchWorkspace handles ARXML files larger than 50MB', async function () {
    this.timeout(120000);

    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const largeFile = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-large-${Date.now()}.arxml`));
    await writeLargeArxmlFile(largeFile.fsPath, 52 * 1024 * 1024, 'HugeAlpha');
    filesToCleanup.push(largeFile);

    const stat = await vscode.workspace.fs.stat(largeFile);
    assert.ok(stat.size > 50 * 1024 * 1024, 'expected generated fixture to exceed 50MB');

    const provider = new CrossFileSearchProvider();
    const filter: TreeFilterConfig = { mode: 'contains', name: 'HugeAlpha' };
    const result = await provider.searchWorkspace(filter);

    const matchedFile = result.files.find(entry => entry.file.fsPath === largeFile.fsPath);
    assert.ok(matchedFile, 'expected large file to be searchable');
    assert.ok((matchedFile?.totalCount ?? 0) >= 1, 'expected at least one match in large file');
    provider.dispose();
  });

  test('searchWorkspace keeps parsed file cache bounded', async function () {
    this.timeout(120000);

    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const fileCount = 24;
    for (let i = 0; i < fileCount; i++) {
      const file = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-cache-${Date.now()}-${i}.arxml`));
      const content = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><ECUC><SHORT-NAME>Cache${i}</SHORT-NAME></ECUC></AUTOSAR>`;
      await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
      filesToCleanup.push(file);
    }

    const provider = new CrossFileSearchProvider();
    const filter: TreeFilterConfig = { mode: 'contains', name: 'DefinitelyNoMatch' };
    await provider.searchWorkspace(filter);

    const stats = provider.getCacheStats();
    assert.ok(stats.size <= 20, `expected bounded cache size, got ${stats.size}`);
    provider.dispose();
  });

  test('searchWorkspace respects external abort signal', async function () {
    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const file = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-abort-${Date.now()}.arxml`));
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><ECUC><SHORT-NAME>AbortMe</SHORT-NAME></ECUC></AUTOSAR>`;
    await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
    filesToCleanup.push(file);

    const provider = new CrossFileSearchProvider();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      provider.searchWorkspace({ mode: 'contains', name: 'AbortMe' }, undefined, controller.signal),
      /Search was cancelled/
    );
    provider.dispose();
  });

  test('searchWorkspace large-file warm cache does not regress heavily', async function () {
    this.timeout(180000);

    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const largeFile = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-perf-${Date.now()}.arxml`));
    await writeLargeArxmlFile(largeFile.fsPath, 52 * 1024 * 1024, 'HugePerfAlpha');
    filesToCleanup.push(largeFile);

    const provider = new CrossFileSearchProvider();
    const filter: TreeFilterConfig = { mode: 'contains', name: 'HugePerfAlpha' };

    const cold = await provider.searchWorkspace(filter);
    const warm = await provider.searchWorkspace(filter);

    console.log(`CrossFileSearchProvider large-file perf: cold=${cold.searchTime}ms warm=${warm.searchTime}ms`);

    assert.ok(cold.searchTime >= 0, 'cold searchTime should be non-negative');
    assert.ok(warm.searchTime >= 0, 'warm searchTime should be non-negative');
    assert.ok(
      warm.searchTime <= cold.searchTime + 2000,
      `expected warm cache run not to regress heavily: cold=${cold.searchTime} warm=${warm.searchTime}`
    );

    provider.dispose();
  });

  test('searchWorkspace small-file warm cache baseline', async function () {
    this.timeout(120000);

    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const smallFile = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-small-perf-${Date.now()}.arxml`));
    await writeSizedArxmlFile(smallFile.fsPath, 1 * 1024 * 1024, 'SmallPerfAlpha');
    filesToCleanup.push(smallFile);

    const provider = new CrossFileSearchProvider();
    const filter: TreeFilterConfig = { mode: 'contains', name: 'SmallPerfAlpha' };

    const cold = await provider.searchWorkspace(filter);
    const warm = await provider.searchWorkspace(filter);

    console.log(`CrossFileSearchProvider small-file perf: cold=${cold.searchTime}ms warm=${warm.searchTime}ms`);

    assert.ok(cold.searchTime >= 0, 'cold searchTime should be non-negative');
    assert.ok(warm.searchTime >= 0, 'warm searchTime should be non-negative');
    provider.dispose();
  });

  test('searchWorkspace handles multiple large files with bounded overhead', async function () {
    this.timeout(300000);

    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const provider = new CrossFileSearchProvider();
    const fileCount = 3;
    const createdFiles: vscode.Uri[] = [];

    for (let i = 0; i < fileCount; i++) {
      const file = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-multi-large-${Date.now()}-${i}.arxml`));
      await writeLargeArxmlFile(file.fsPath, 52 * 1024 * 1024, `HugeMultiAlpha${i}`);
      filesToCleanup.push(file);
      createdFiles.push(file);
    }

    const cold = await provider.searchWorkspace({ mode: 'contains', name: 'HugeMultiAlpha' });
    const warm = await provider.searchWorkspace({ mode: 'contains', name: 'HugeMultiAlpha' });

    const matchedFiles = cold.files.filter(entry => createdFiles.some(file => file.fsPath === entry.file.fsPath));
    console.log(`CrossFileSearchProvider multi-large perf: files=${fileCount} cold=${cold.searchTime}ms warm=${warm.searchTime}ms matches=${matchedFiles.length}`);

    assert.ok(matchedFiles.length >= fileCount, `expected at least ${fileCount} large generated files in results, got ${matchedFiles.length}`);
    assert.ok(cold.searchTime >= 0, 'cold searchTime should be non-negative');
    assert.ok(warm.searchTime >= 0, 'warm searchTime should be non-negative');
    assert.ok(
      warm.searchTime <= cold.searchTime + 4000,
      `expected warm run not to regress heavily: cold=${cold.searchTime} warm=${warm.searchTime}`
    );

    provider.dispose();
  });

  test('searchWorkspace handles multiple small files baseline', async function () {
    this.timeout(180000);

    const workspaceRoot = getWorkspaceRootUri();
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const provider = new CrossFileSearchProvider();
    const fileCount = 3;
    const createdFiles: vscode.Uri[] = [];

    for (let i = 0; i < fileCount; i++) {
      const file = vscode.Uri.file(path.join(workspaceRoot.fsPath, `cross-search-multi-small-${Date.now()}-${i}.arxml`));
      await writeSizedArxmlFile(file.fsPath, 1 * 1024 * 1024, `SmallMultiAlpha${i}`);
      filesToCleanup.push(file);
      createdFiles.push(file);
    }

    const cold = await provider.searchWorkspace({ mode: 'contains', name: 'SmallMultiAlpha' });
    const warm = await provider.searchWorkspace({ mode: 'contains', name: 'SmallMultiAlpha' });

    const matchedFiles = cold.files.filter(entry => createdFiles.some(file => file.fsPath === entry.file.fsPath));
    console.log(`CrossFileSearchProvider multi-small perf: files=${fileCount} cold=${cold.searchTime}ms warm=${warm.searchTime}ms matches=${matchedFiles.length}`);

    assert.ok(matchedFiles.length >= fileCount, `expected at least ${fileCount} generated small files in results, got ${matchedFiles.length}`);
    assert.ok(cold.searchTime >= 0, 'cold searchTime should be non-negative');
    assert.ok(warm.searchTime >= 0, 'warm searchTime should be non-negative');
    provider.dispose();
  });
});

async function writeLargeArxmlFile(filePath: string, minBytes: number, markerName: string): Promise<void> {
  await writeSizedArxmlFile(filePath, minBytes, markerName);
}

async function writeSizedArxmlFile(filePath: string, minBytes: number, markerName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
    stream.on('error', reject);

    const writeChunk = async (chunk: string): Promise<void> => {
      if (!stream.write(chunk)) {
        await once(stream, 'drain');
      }
    };

    const run = async () => {
      await writeChunk('<?xml version="1.0" encoding="UTF-8"?>\n');
      await writeChunk('<AUTOSAR>\n');
      await writeChunk(`  <ECUC><SHORT-NAME>${markerName}</SHORT-NAME></ECUC>\n`);

      const filler = `  <!--${'x'.repeat(4096)}-->\n`;
      let written = Buffer.byteLength('<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR>\n')
        + Buffer.byteLength(`  <ECUC><SHORT-NAME>${markerName}</SHORT-NAME></ECUC>\n`);

      while (written < minBytes) {
        await writeChunk(filler);
        written += Buffer.byteLength(filler);
      }

      await writeChunk('</AUTOSAR>\n');
      stream.end();
      await once(stream, 'finish');
    };

    void run().then(resolve).catch(reject);
  });
}

function getWorkspaceRootUri(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
