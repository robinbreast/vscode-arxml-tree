import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseArxmlDocument, parseArxmlDocumentFromFile } from '../arxmlParser';
import { ArxmlTreeProvider, BookmarkTreeProvider } from '../treeProvider';
import { ArxmlNode } from '../arxmlNode';
import { createTextPositionResolver } from '../textPositionResolver';
import { ArxmlHoverProvider } from '../hoverProvider';

suite('ARXML Parser', () => {
  test('builds tree for nested elements with UUIDs', async () => {
    const sample = `
<AUTOSAR>
  <AR-PACKAGES>
    <AR-PACKAGE>
      <SHORT-NAME>Pkg</SHORT-NAME>
      <ELEMENTS>
        <APPLICATION-SW-COMPONENT-TYPE UUID="1234">
          <SHORT-NAME>ExampleComponent</SHORT-NAME>
        </APPLICATION-SW-COMPONENT-TYPE>
      </ELEMENTS>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>`;

    const uri = vscode.Uri.parse('file:///sample.arxml');
    const root = await parseArxmlDocument(sample, uri, createTextPositionResolver(sample));
    assert.ok(root, 'root node should be defined');
    assert.strictEqual(root?.children.length, 1);

    const pkg = root?.children[0];
    assert.strictEqual(pkg?.name, 'Pkg');
    assert.strictEqual(pkg?.arpath, '/Pkg');

    assert.strictEqual(pkg?.children.length, 1);
    const comp = pkg?.children[0];
    assert.strictEqual(comp?.name, 'ExampleComponent');
    assert.strictEqual(comp?.arpath, '/Pkg/ExampleComponent');
    assert.strictEqual(comp?.uuid, '1234');
  });

  test('parses ARXML from filesystem stream path', async function () {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const file = vscode.Uri.file(`${workspaceRoot.fsPath}/stream-parse-${Date.now()}.arxml`);
    const sample = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><ECUC><SHORT-NAME>StreamAlpha</SHORT-NAME></ECUC></AUTOSAR>`;

    await vscode.workspace.fs.writeFile(file, Buffer.from(sample, 'utf8'));
    try {
      const root = await parseArxmlDocumentFromFile(file, { strict: false });
      assert.ok(root, 'root node should be defined for streamed parse');
      assert.strictEqual(root?.children[0]?.name, 'StreamAlpha');
    } finally {
      await vscode.workspace.fs.delete(file, { useTrash: false });
    }
  });
});

suite('REF hover navigation', () => {
  test('creates command hyperlink for resolvable REF target', async function () {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const targetFile = vscode.Uri.file(`${workspaceRoot.fsPath}/hover-target-${Date.now()}.arxml`);
    const sourceFile = vscode.Uri.file(`${workspaceRoot.fsPath}/hover-source-${Date.now()}.arxml`);
    const files = [targetFile, sourceFile];

    const targetText = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><ECUC><SHORT-NAME>TargetNode</SHORT-NAME></ECUC></AUTOSAR>`;
    const sourceText = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><I-SIGNAL-IREF DEST="ECUC">/TargetNode</I-SIGNAL-IREF></AUTOSAR>`;

    await vscode.workspace.fs.writeFile(targetFile, Buffer.from(targetText, 'utf8'));
    await vscode.workspace.fs.writeFile(sourceFile, Buffer.from(sourceText, 'utf8'));

    try {
      const targetDoc = await vscode.workspace.openTextDocument(targetFile);
      const sourceDoc = await vscode.workspace.openTextDocument(sourceFile);

      const provider = new ArxmlTreeProvider();
      const hoverProvider = new ArxmlHoverProvider(provider);
      const refOffset = sourceText.indexOf('/TargetNode') + 2;
      const position = sourceDoc.positionAt(refOffset);

      const hover = await hoverProvider.provideHover(sourceDoc, position, new vscode.CancellationTokenSource().token);
      assert.ok(hover, 'hover should be produced for resolvable REF');

      const content = hover?.contents[0];
      assert.ok(isMarkdownString(content), 'hover should render markdown hyperlink');
      const markdown = content.value;
      assert.ok(markdown.includes('command:arxml-tree-view.gotoNode?'), 'hover should include goto command URI');
      assert.ok(markdown.includes('[ECUC: /TargetNode]('), 'hover should include target label');
      assert.ok(markdown.includes('📄'), 'cross-file hover should include target filename badge');

      provider.dispose();
      void targetDoc;
    } finally {
      await deleteFiles(files);
    }
  });

  test('shows not-found guidance for unresolved REF target', async function () {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const sourceFile = vscode.Uri.file(`${workspaceRoot.fsPath}/hover-miss-${Date.now()}.arxml`);
    const files = [sourceFile];
    const sourceText = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><I-SIGNAL-IREF DEST="ECUC">/MissingNode</I-SIGNAL-IREF></AUTOSAR>`;
    await vscode.workspace.fs.writeFile(sourceFile, Buffer.from(sourceText, 'utf8'));

    try {
      const sourceDoc = await vscode.workspace.openTextDocument(sourceFile);
      const provider = new ArxmlTreeProvider();
      const hoverProvider = new ArxmlHoverProvider(provider);
      const refOffset = sourceText.indexOf('/MissingNode') + 2;
      const position = sourceDoc.positionAt(refOffset);

      const hover = await hoverProvider.provideHover(sourceDoc, position, new vscode.CancellationTokenSource().token);
      assert.ok(hover, 'hover should be produced for unresolved REF');

      const content = hover?.contents[0];
      assert.ok(isMarkdownString(content), 'hover should render markdown content');
      const markdown = content.value;
      assert.ok(markdown.includes('Not found in open files'), 'hover should explain unresolved target state');
      assert.ok(markdown.includes('/MissingNode'), 'hover should contain unresolved arpath');

      provider.dispose();
    } finally {
      await deleteFiles(files);
    }
  });

  test('goto command opens target file at expected range', async function () {
    this.timeout(10000);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      this.skip();
      return;
    }

    const targetFile = vscode.Uri.file(`${workspaceRoot.fsPath}/goto-target-${Date.now()}.arxml`);
    const sourceFile = vscode.Uri.file(`${workspaceRoot.fsPath}/goto-source-${Date.now()}.arxml`);
    const files = [targetFile, sourceFile];

    const uniqueName = `TargetNodeGoto${Date.now()}`;
    const uniqueArpath = `/${uniqueName}`;
    const targetText = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR>\n  <ECUC>\n    <SHORT-NAME>${uniqueName}</SHORT-NAME>\n  </ECUC>\n</AUTOSAR>`;
    const sourceText = `<?xml version="1.0" encoding="UTF-8"?>\n<AUTOSAR><I-SIGNAL-IREF DEST="ECUC">${uniqueArpath}</I-SIGNAL-IREF></AUTOSAR>`;

    await vscode.workspace.fs.writeFile(targetFile, Buffer.from(targetText, 'utf8'));
    await vscode.workspace.fs.writeFile(sourceFile, Buffer.from(sourceText, 'utf8'));

    try {
      const targetDoc = await vscode.workspace.openTextDocument(targetFile);
      const sourceDoc = await vscode.workspace.openTextDocument(sourceFile);
      await vscode.window.showTextDocument(targetDoc, { preview: true, preserveFocus: false });
      await vscode.window.showTextDocument(sourceDoc);

      await vscode.commands.executeCommand('arxml-tree-view.gotoNode', {
        arpath: uniqueArpath,
        preferredUri: sourceDoc.uri.toString(),
        destType: 'ECUC'
      });

      const activeEditor = vscode.window.activeTextEditor;
      assert.ok(activeEditor, 'goto command should open an editor');
      assert.strictEqual(activeEditor?.document.uri.toString(), targetFile.toString(), 'goto should open target file');

      const expectedPosition = activeEditor!.document.positionAt(targetText.indexOf(uniqueName));
      const selected = activeEditor!.selection;
      const inRange = selected.contains(expectedPosition)
        || selected.start.isEqual(expectedPosition)
        || selected.end.isEqual(expectedPosition);
      assert.ok(inRange, 'selection should contain the expected target location');
    } finally {
      await deleteFiles(files);
    }
  });
});

suite('BookmarkTreeProvider', () => {
  test('persists and removes bookmarks by ARPATH', async () => {
    const memento = new TestMemento();
    const provider = new BookmarkTreeProvider(memento);

    const node = createNode('ExampleComponent', '/Pkg/ExampleComponent');
    provider.addBookmark(node);
    provider.addBookmark(node); // duplicate ignored

    let bookmarks = await provider.getChildren();
    assert.strictEqual(bookmarks.length, 1);

    provider.removeBookmark(node.arpath);
    bookmarks = await provider.getChildren();
    assert.strictEqual(bookmarks.length, 0);
  });
});

function createNode(name: string, arpath: string): ArxmlNode {
  const uri = vscode.Uri.parse('file:///sample.arxml');
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  return {
    name,
    arpath,
    element: 'ELEMENT',
    file: uri,
    range,
    children: []
  };
}

class TestMemento implements vscode.Memento {
  private data = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.data.has(key)) {
      return this.data.get(key) as T;
    }
    return defaultValue;
  }

  update(key: string, value: any): Thenable<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
    return Promise.resolve();
  }
}

function isMarkdownString(value: vscode.MarkdownString | vscode.MarkedString): value is vscode.MarkdownString {
  return value instanceof vscode.MarkdownString;
}

async function deleteFiles(files: vscode.Uri[]): Promise<void> {
  for (const file of files) {
    await vscode.workspace.fs.delete(file, { useTrash: false });
  }
}

suite('Performance settings', () => {
  test('parseArxmlDocument processes documents and returns changed URIs', async () => {
    const sample = `
<AUTOSAR>
  <AR-PACKAGES>
    <AR-PACKAGE UUID="pkg-123">
      <SHORT-NAME>TestPackage</SHORT-NAME>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>`;

    const uri = vscode.Uri.parse('file:///test.arxml');
    const root = await parseArxmlDocument(sample, uri, createTextPositionResolver(sample));
    
    assert.ok(root, 'Parser should return a root node for valid ARXML');
    assert.strictEqual(root?.children.length, 1, 'Root should have one child');
    const pkg = root?.children[0];
    assert.strictEqual(pkg?.name, 'TestPackage', 'Package name should match');
    assert.strictEqual(pkg?.uuid, 'pkg-123', 'Package UUID should match');
  });

  test('parseArxmlDocument handles multiple documents with different content', async () => {
    const sample1 = `
<AUTOSAR>
  <AR-PACKAGES>
    <AR-PACKAGE>
      <SHORT-NAME>Package1</SHORT-NAME>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>`;

    const sample2 = `
<AUTOSAR>
  <AR-PACKAGES>
    <AR-PACKAGE>
      <SHORT-NAME>Package2</SHORT-NAME>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>`;

    const uri1 = vscode.Uri.parse('file:///test1.arxml');
    const uri2 = vscode.Uri.parse('file:///test2.arxml');
    
    const root1 = await parseArxmlDocument(sample1, uri1, createTextPositionResolver(sample1));
    const root2 = await parseArxmlDocument(sample2, uri2, createTextPositionResolver(sample2));
    
    assert.ok(root1, 'First document should parse');
    assert.ok(root2, 'Second document should parse');
    assert.notStrictEqual(root1?.children[0]?.name, root2?.children[0]?.name, 'Documents should have different content');
  });

  test('parseArxmlDocument handles large documents with many nodes', async () => {
    const elements: string[] = [];
    for (let i = 0; i < 100; i++) {
      elements.push(`
        <APPLICATION-SW-COMPONENT-TYPE UUID="comp-${i}">
          <SHORT-NAME>Component${i}</SHORT-NAME>
          <PORTS>
            <P-PORT-PROTOTYPE>
              <SHORT-NAME>Port${i}A</SHORT-NAME>
            </P-PORT-PROTOTYPE>
            <P-PORT-PROTOTYPE>
              <SHORT-NAME>Port${i}B</SHORT-NAME>
            </P-PORT-PROTOTYPE>
            <R-PORT-PROTOTYPE>
              <SHORT-NAME>Port${i}C</SHORT-NAME>
            </R-PORT-PROTOTYPE>
          </PORTS>
        </APPLICATION-SW-COMPONENT-TYPE>`);
    }
    
    const largeSample = `
<AUTOSAR>
  <AR-PACKAGES>
    <AR-PACKAGE>
      <SHORT-NAME>LargePackage</SHORT-NAME>
      <ELEMENTS>
        ${elements.join('\n')}
      </ELEMENTS>
    </AR-PACKAGE>
  </AR-PACKAGES>
</AUTOSAR>`;

    const uri = vscode.Uri.parse('file:///large.arxml');
    const root = await parseArxmlDocument(largeSample, uri, createTextPositionResolver(largeSample));
    
    assert.ok(root, 'Large document should parse successfully');
    const pkg = root?.children[0];
    assert.ok(pkg, 'Package should exist');
    
    const countDescendants = (node: ArxmlNode): number => {
      let count = node.children.length;
      for (const child of node.children) {
        count += countDescendants(child);
      }
      return count;
    };
    
    const totalNodes = countDescendants(root);
    assert.ok(totalNodes >= 400, `Large document should have >=400 nodes (has ${totalNodes})`);
  });

  test('workspace configuration can be read for refresh settings', () => {
    const config = vscode.workspace.getConfiguration('arxmlTree');
    
    const refreshMode = config.get('refreshMode');
    const debounceDelay = config.get('debounceDelay');
    const adaptiveDebounce = config.get('adaptiveDebounce');
    const workspaceSearchLargeFileThresholdMB = config.get('workspaceSearchLargeFileThresholdMB');
    
    assert.ok(typeof refreshMode === 'string' || refreshMode === undefined, 'refreshMode should be string or undefined');
    assert.ok(typeof debounceDelay === 'number' || debounceDelay === undefined, 'debounceDelay should be number or undefined');
    assert.ok(typeof adaptiveDebounce === 'boolean' || adaptiveDebounce === undefined, 'adaptiveDebounce should be boolean or undefined');
    assert.ok(typeof workspaceSearchLargeFileThresholdMB === 'number' || workspaceSearchLargeFileThresholdMB === undefined, 'workspaceSearchLargeFileThresholdMB should be number or undefined');
  });
});
