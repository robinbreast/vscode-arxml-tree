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
