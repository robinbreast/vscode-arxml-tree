import * as vscode from 'vscode';
import * as path from 'path';
import { parseArxmlDocument } from './arxmlParser';
import { ArxmlNode, equalsArxmlNodes } from './arxmlNode';

export class ArxmlTreeProvider implements vscode.TreeDataProvider<ArxmlNode>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | undefined | void> = this._onDidChangeTreeData.event;

  private arxmlDocument: vscode.TextDocument | undefined;
  private parsedDocuments: Map<string, { root: ArxmlNode; version: number }> = new Map();
  private lastHighlightedNode: ArxmlNode | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private parsePromise: Promise<void> | undefined;
  private arpathIndex: Map<string, ArxmlNode[]> = new Map();

  private readonly highlightType: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(0, 200, 0, 0.2)',
  });

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this),
      vscode.window.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditor, this),
      vscode.window.onDidChangeTextEditorSelection(this.onDidChangeTextEditorSelection, this)
    );

    this.arxmlDocument = this.getActiveArxmlDocument();
    if (this.arxmlDocument) {
      void this.rebuildTree();
    }
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.highlightType.dispose();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }

  refresh(document?: vscode.TextDocument): void {
    if (document && document.languageId === 'arxml') {
      this.arxmlDocument = document;
    } else if (!this.arxmlDocument) {
      this.arxmlDocument = this.getActiveArxmlDocument();
    }

    this.scheduleRefresh();
  }

  private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (event.document.languageId !== 'arxml') {
      return;
    }

    if (!this.arxmlDocument || event.document.uri.toString() === this.arxmlDocument.uri.toString()) {
      this.arxmlDocument = event.document;
      this.scheduleRefresh();
    }
  }

  private onDidChangeActiveTextEditor(editor: vscode.TextEditor | undefined): void {
    if (editor && editor.document.languageId === 'arxml') {
      this.arxmlDocument = editor.document;
      this.scheduleRefresh(true);
    } else {
      // Don't clear parsed documents when switching away from ARXML
      // This preserves the cross-file index for hover navigation
      this.arxmlDocument = undefined;
      // Only update the tree view to show empty state
      this._onDidChangeTreeData.fire();
    }
  }

  private onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.arxmlDocument || event.textEditor.document.uri.toString() !== this.arxmlDocument.uri.toString()) {
      return;
    }

    const editor = event.textEditor;
    if (editor.document.languageId === 'arxml' && event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
      const lineNumber = event.selections[0].active.line + 1; // Line numbers are 0-based, so add 1
      this.getDocumentRoot(editor.document.uri.toString()).then(rootNode => {
        if (!rootNode) {
          return;
        }
        let closestNode: ArxmlNode | undefined = undefined;
        const stack: ArxmlNode[] = [rootNode];
        while (stack.length > 0) {
          const currentNode = stack.pop()!;
          if (lineNumber >= currentNode.range.start.line && lineNumber <= currentNode.range.end.line) {
            if (!closestNode ||
              (currentNode.range.end.line - currentNode.range.start.line < closestNode.range.end.line - closestNode.range.start.line)) {
              closestNode = currentNode;
            }
          }
          stack.push(...currentNode.children);
        }
        if (closestNode && closestNode !== this.lastHighlightedNode) {
          vscode.commands.executeCommand('arxml-tree-view.focusNode', closestNode);
          editor.setDecorations(this.highlightType, [closestNode.range]);
          this.lastHighlightedNode = closestNode;
        }
      });
    }
  }

  getTreeItem(node: ArxmlNode): vscode.TreeItem {
    return {
      label: node.name,
      collapsibleState: node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      tooltip: `ELEMENT: ${node.element}\nARPATH: ${node.arpath}\nUUID: ${node.uuid}\nFile: ${node.file.fsPath}\nLine: ${node.range.start.line + 1} ~ ${node.range.end.line + 1}`
    };
  }

  getParent(node: ArxmlNode): ArxmlNode | undefined {
    return node.parent;
  }

  getChildren(node?: ArxmlNode): Thenable<ArxmlNode[]> {
    if (node && node.children) {
      return Promise.resolve(node.children);
    }
    return Promise.resolve(this.getRootNodes());
  }

  findNode(node: ArxmlNode): ArxmlNode | undefined {
    for (const root of this.getRootNodes()) {
      const found = this.findInTree(root, candidate => equalsArxmlNodes(candidate, node));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  async findNodeWithArPath(targetLabel: string): Promise<ArxmlNode | undefined> {
    // Ensure all open ARXML documents are parsed, not just the active one
    await this.ensureAllDocumentsParsed();

    const normalized = normalizeArpath(targetLabel);
    const direct = this.findByArpath(normalized);
    if (direct) {
      return direct;
    }

    const labels = normalized.split('/').filter(label => label.trim() !== '');
    for (const root of this.getRootNodes()) {
      const found = this.walkPath(root, labels);
      if (found) {
        return found;
      }
    }

    // Fallback: Search for the path as a text string in open documents
    // This helps find ECUC definitions that might not have SHORT-NAME structure
    const fallback = await this.findByTextSearch(normalized);
    if (fallback) {
      return fallback;
    }

    return undefined;
  }

  private async findByTextSearch(arpath: string): Promise<ArxmlNode | undefined> {
    const pathParts = arpath.split('/').filter(Boolean);
    if (pathParts.length === 0) {
      return undefined;
    }

    // Search for the last part of the path in all open documents
    const searchTerm = pathParts[pathParts.length - 1];
    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const documents = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'arxml');

    for (const doc of documents) {
      const text = doc.getText();

      // Try multiple search patterns for better matching
      const patterns = [
        `>\\s*${escapedTerm}\\s*<`,           // <TAG>Name</TAG>
        `"${escapedTerm}"`,                    // ATTR="Name"
        `/${escapedTerm}(?:/|\\s|$)`          // /Name/ or /Name at end
      ];

      for (const pattern of patterns) {
        const regex = new RegExp(pattern, 'g');
        const match = regex.exec(text);

        if (match) {
          const matchOffset = match.index;
          const position = doc.positionAt(matchOffset);

          // Find the start of the line to get better context
          const lineStart = doc.lineAt(position.line).range.start;
          const lineEnd = doc.lineAt(position.line).range.end;

          // Create a node pointing to this location
          const node: ArxmlNode = {
            name: searchTerm,
            arpath: arpath,
            element: 'DEFINITION',
            file: doc.uri,
            range: new vscode.Range(lineStart, lineEnd),
            parent: undefined,
            children: []
          };

          return node;
        }
      }
    }

    return undefined;
  }

  private scheduleRefresh(forceImmediate = false): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    const delay = forceImmediate ? 0 : 200;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.rebuildTree();
    }, delay);
  }

  private async rebuildTree(): Promise<void> {
    const targetDocuments = this.collectArxmlDocuments();
    if (!targetDocuments.length) {
      if (this.parsedDocuments.size) {
        this.parsedDocuments.clear();
        this._onDidChangeTreeData.fire();
      }
      return;
    }

    if (this.parsePromise) {
      await this.parsePromise;
      return;
    }

    this.parsePromise = this.parseDocuments(targetDocuments)
      .then(changed => {
        if (changed) {
          this._onDidChangeTreeData.fire();
        }
      })
      .catch(error => {
        vscode.window.showErrorMessage(`Failed to parse ARXML file: ${(error as Error).message}`);
      })
      .finally(() => {
        this.parsePromise = undefined;
      });

    await this.parsePromise;
  }

  private async ensureAllDocumentsParsed(): Promise<void> {
    // Collect all open ARXML documents
    const allArxmlDocs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'arxml');

    if (allArxmlDocs.length === 0) {
      return;
    }

    // Check which documents are not yet parsed or outdated
    const docsToParse: vscode.TextDocument[] = [];
    for (const doc of allArxmlDocs) {
      const uriString = doc.uri.toString();
      const cached = this.parsedDocuments.get(uriString);
      if (!cached || cached.version !== doc.version) {
        docsToParse.push(doc);
      }
    }

    // Parse any missing or outdated documents
    if (docsToParse.length > 0) {
      await this.parseDocuments(docsToParse);
    } else if (this.arpathIndex.size === 0 && this.parsedDocuments.size > 0) {
      // If index is empty but we have parsed documents, rebuild the index
      this.rebuildArpathIndex();
    }
  }

  private getActiveArxmlDocument(): vscode.TextDocument | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'arxml') {
      return editor.document;
    }
    return undefined;
  }

  private collectArxmlDocuments(): vscode.TextDocument[] {
    const openDocs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'arxml');
    if (openDocs.length === 0 && this.arxmlDocument) {
      return [this.arxmlDocument];
    }
    if (this.arxmlDocument && !openDocs.find(doc => doc.uri.toString() === this.arxmlDocument!.uri.toString())) {
      openDocs.push(this.arxmlDocument);
    }
    return openDocs;
  }

  private async parseDocuments(documents: vscode.TextDocument[]): Promise<boolean> {
    let changed = false;
    for (const document of documents) {
      const uriString = document.uri.toString();
      const cached = this.parsedDocuments.get(uriString);
      if (cached && cached.version === document.version) {
        continue;
      }
      try {
        const root = await parseArxmlDocument(document.getText(), document.uri, (offset) => document.positionAt(offset));
        if (root) {
          root.name = path.basename(document.uri.fsPath);
          root.parent = undefined;
          this.parsedDocuments.set(uriString, { root, version: document.version });
          changed = true;
        } else if (this.parsedDocuments.has(uriString)) {
          this.parsedDocuments.delete(uriString);
          changed = true;
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to parse ARXML file ${document.uri.fsPath}: ${(error as Error).message}`);
      }
    }

    // Rebuild the entire index from all parsed documents
    if (changed) {
      this.rebuildArpathIndex();
    }

    return changed;
  }

  private rebuildArpathIndex(): void {
    const nextIndex: Map<string, ArxmlNode[]> = new Map();
    for (const { root } of this.parsedDocuments.values()) {
      this.indexTree(root, nextIndex);
    }
    this.arpathIndex = nextIndex;
  }

  private getRootNodes(): ArxmlNode[] {
    return Array.from(this.parsedDocuments.values())
      .map(entry => entry.root)
      .sort((a, b) => a.file.fsPath.localeCompare(b.file.fsPath));
  }

  private async getDocumentRoot(uriString: string): Promise<ArxmlNode | undefined> {
    if (!this.parsedDocuments.has(uriString)) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriString);
      if (doc) {
        await this.parseDocuments([doc]);
      }
    }
    return this.parsedDocuments.get(uriString)?.root;
  }

  private findInTree(root: ArxmlNode, predicate: (node: ArxmlNode) => boolean): ArxmlNode | undefined {
    const stack: ArxmlNode[] = [root];
    while (stack.length) {
      const current = stack.pop()!;
      if (predicate(current)) {
        return current;
      }
      stack.push(...current.children);
    }
    return undefined;
  }

  private walkPath(root: ArxmlNode, labels: string[]): ArxmlNode | undefined {
    const normalizedLabels = [...labels];
    const rootAliases = this.getRootAliases(root.name);
    if (normalizedLabels.length) {
      if (rootAliases.has(normalizedLabels[0])) {
        normalizedLabels.shift();
      } else {
        const child = root.children.find(node => node.name === normalizedLabels[0]);
        if (child) {
          normalizedLabels.shift();
          return this.walkPath(child, normalizedLabels);
        }
      }
    }

    let currentNode: ArxmlNode | undefined = root;
    for (const label of normalizedLabels) {
      if (!currentNode?.children) {
        return undefined;
      }
      const foundNode: ArxmlNode | undefined = currentNode.children.find(node => node.name === label);
      if (!foundNode) {
        return undefined;
      }
      currentNode = foundNode;
    }
    return currentNode;
  }

  private findByArpath(target: string): ArxmlNode | undefined {
    const variants = buildArpathVariants(target);
    for (const variant of variants) {
      const matches = this.arpathIndex.get(variant);
      if (matches && matches.length > 0) {
        return matches[0];
      }
    }
    for (const root of this.getRootNodes()) {
      const found = this.findInTree(root, node => variants.some(variant => node.arpath === variant || node.arpath.endsWith(variant)));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private getRootAliases(rootName: string): Set<string> {
    const aliases = new Set<string>([rootName]);
    const base = path.parse(rootName).name;
    aliases.add(base);
    const parts = base.split('.');
    if (parts.length > 1) {
      aliases.add(parts[0]);
    }
    return aliases;
  }

  private indexTree(root: ArxmlNode, index: Map<string, ArxmlNode[]>): void {
    const stack: ArxmlNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      const variants = buildArpathVariants(node.arpath);
      for (const variant of variants) {
        const list = index.get(variant) ?? [];
        list.push(node);
        index.set(variant, list);
      }
      stack.push(...node.children);
    }
  }
}

function normalizeArpath(arpath: string): string {
  if (!arpath) {
    return '';
  }
  let normalized = arpath.trim();
  normalized = normalized.replace(/[\r\n\t]/g, '');
  normalized = normalized.replace(/\/+/g, '/');
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  if (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function buildArpathVariants(arpath: string): string[] {
  const variants = new Set<string>();
  const normalized = normalizeArpath(arpath);
  variants.add(normalized);

  const noLeading = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  variants.add(noLeading);

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length > 1) {
    const withoutRoot = '/' + parts.slice(1).join('/');
    variants.add(withoutRoot);
    variants.add(withoutRoot.slice(1));
  }

  return Array.from(variants);
}

interface SerializedBookmark {
  name: string;
  arpath: string;
  element: string;
  file: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  uuid?: string;
}

export class BookmarkTreeProvider implements vscode.TreeDataProvider<ArxmlNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | undefined | void> = this._onDidChangeTreeData.event;
  private readonly bookmarksKey = 'arxmlTree.bookmarks';
  private bookmarks: SerializedBookmark[];

  constructor(private readonly workspaceState: vscode.Memento) {
    this.bookmarks = this.workspaceState.get<SerializedBookmark[]>(this.bookmarksKey, []);
  }

  getTreeItem(node: ArxmlNode): vscode.TreeItem {
    return {
      label: node.name,
      tooltip: `ELEMENT: ${node.element}\nARPATH: ${node.arpath}\nUUID: ${node.uuid}\nFile: ${node.file.fsPath}\nLine: ${node.range.start.line + 1} ~ ${node.range.end.line + 1}`,
      contextValue: 'bookmarkNode'
    };
  }

  getChildren(): Thenable<ArxmlNode[]> {
    return Promise.resolve(this.bookmarks.map(bookmark => this.toArxmlNode(bookmark)));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  addBookmark(node: ArxmlNode) {
    if (this.bookmarks.some(item => item.arpath === node.arpath)) {
      return;
    }

    this.bookmarks.push(this.serializeNode(node));
    this.persist();
    this.refresh();
  }

  removeBookmark(target: ArxmlNode | string): void {
    const arpath = typeof target === 'string' ? target : target.arpath;
    const nextBookmarks = this.bookmarks.filter(bookmark => bookmark.arpath !== arpath);
    if (nextBookmarks.length !== this.bookmarks.length) {
      this.bookmarks = nextBookmarks;
      this.persist();
      this.refresh();
    }
  }

  private persist(): void {
    void this.workspaceState.update(this.bookmarksKey, this.bookmarks);
  }

  private serializeNode(node: ArxmlNode): SerializedBookmark {
    return {
      name: node.name,
      arpath: node.arpath,
      element: node.element,
      file: node.file.toString(),
      range: {
        start: { line: node.range.start.line, character: node.range.start.character },
        end: { line: node.range.end.line, character: node.range.end.character }
      },
      uuid: node.uuid
    };
  }

  private toArxmlNode(bookmark: SerializedBookmark): ArxmlNode {
    return {
      name: bookmark.name,
      arpath: bookmark.arpath,
      element: bookmark.element,
      file: vscode.Uri.parse(bookmark.file),
      range: new vscode.Range(
        new vscode.Position(bookmark.range.start.line, bookmark.range.start.character),
        new vscode.Position(bookmark.range.end.line, bookmark.range.end.character)
      ),
      uuid: bookmark.uuid,
      parent: undefined,
      children: []
    };
  }
}
