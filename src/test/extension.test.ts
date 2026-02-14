import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseArxmlDocument } from '../arxmlParser';
import { BookmarkTreeProvider } from '../treeProvider';
import { ArxmlNode } from '../arxmlNode';

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
    const root = await parseArxmlDocument(sample, uri, createPositionResolver(sample));
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

function createPositionResolver(text: string): (offset: number) => vscode.Position {
  const lineOffsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineOffsets.push(i + 1);
    }
  }

  return (offset: number) => {
    const clamped = Math.max(0, Math.min(text.length, offset));
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const lineStart = lineOffsets[mid];
      const nextLineStart = mid + 1 < lineOffsets.length ? lineOffsets[mid + 1] : text.length + 1;
      if (clamped >= lineStart && clamped < nextLineStart) {
        return new vscode.Position(mid, clamped - lineStart);
      } else if (clamped < lineStart) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return new vscode.Position(0, clamped);
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
    const root = await parseArxmlDocument(sample, uri, createPositionResolver(sample));
    
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
    
    const root1 = await parseArxmlDocument(sample1, uri1, createPositionResolver(sample1));
    const root2 = await parseArxmlDocument(sample2, uri2, createPositionResolver(sample2));
    
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
    const root = await parseArxmlDocument(largeSample, uri, createPositionResolver(largeSample));
    
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
    
    assert.ok(typeof refreshMode === 'string' || refreshMode === undefined, 'refreshMode should be string or undefined');
    assert.ok(typeof debounceDelay === 'number' || debounceDelay === undefined, 'debounceDelay should be number or undefined');
    assert.ok(typeof adaptiveDebounce === 'boolean' || adaptiveDebounce === undefined, 'adaptiveDebounce should be boolean or undefined');
  });
});
