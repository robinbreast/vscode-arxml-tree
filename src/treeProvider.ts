import * as vscode from 'vscode';
import * as path from 'path';
import { parseArxmlDocument } from './arxmlParser';
import { ArxmlNode, equalsArxmlNodes } from './arxmlNode';
import { CustomViewConfig, CustomViewParseMode, CustomViewSort } from './customViewStore';
import { OptimizedTreeProvider, LazyArxmlNode } from './optimizedTreeProvider';

export type TreeFilterMode = 'contains' | 'regex' | 'glob';

export interface TreeFilterConfig {
  mode: TreeFilterMode;
  nameMode?: TreeFilterMode;
  arpathMode?: TreeFilterMode;
  elementMode?: TreeFilterMode;
  name?: string;
  arpath?: string;
  element?: string;
}

export class ArxmlTreeProvider implements vscode.TreeDataProvider<ArxmlNode>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | undefined | void> = this._onDidChangeTreeData.event;

  private arxmlDocument: vscode.TextDocument | undefined;
  private parsedDocuments: Map<string, { root: ArxmlNode; version: number; nameTags: string[]; nameTextTags: string[]; parseMode: CustomViewParseMode }> = new Map();
  private lastHighlightedNode: ArxmlNode | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private parsePromise: Promise<void> | undefined;
  private pendingRefresh: boolean = false;
  private arpathIndex: Map<string, ArxmlNode[]> = new Map();
  private docArpathKeys: Map<string, Set<string>> = new Map();
  private customViewByUri: Map<string, CustomViewConfig | undefined> = new Map();
  private filteredRootsByUri: Map<string, ArxmlNode | undefined> = new Map();
  private filterByUri: Map<string, TreeFilterConfig | undefined> = new Map();
  
  private optimizedProvider: OptimizedTreeProvider;
  private static readonly LARGE_TREE_THRESHOLD = 1000;

  private readonly highlightType: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(0, 200, 0, 0.2)',
  });

  constructor() {
    this.optimizedProvider = new OptimizedTreeProvider();
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this),
      vscode.workspace.onDidSaveTextDocument(this.onDidSaveTextDocument, this),
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
      
      const config = vscode.workspace.getConfiguration('arxmlTree');
      const refreshMode = config.get<string>('refreshMode', 'onChange');
      
      if (refreshMode === 'onChange') {
        this.scheduleRefresh();
      }
    }
  }

  private onDidSaveTextDocument(document: vscode.TextDocument): void {
    if (document.languageId !== 'arxml') {
      return;
    }

    const config = vscode.workspace.getConfiguration('arxmlTree');
    const refreshMode = config.get<string>('refreshMode', 'onChange');
    
    if (refreshMode === 'onSave') {
      if (!this.arxmlDocument || document.uri.toString() === this.arxmlDocument.uri.toString()) {
        this.arxmlDocument = document;
        this.scheduleRefresh();
      }
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

  async getChildren(node?: ArxmlNode): Promise<ArxmlNode[]> {
    if (node && node.children) {
      const filter = this.getCurrentFilter();
      if (this.shouldUseOptimizedProvider(node, filter)) {
        const lazyNode = node as LazyArxmlNode;
        const optimizedChildren = await this.optimizedProvider.getOptimizedChildren(lazyNode, filter);
        return optimizedChildren;
      }
      return node.children;
    }
    return this.getRootNodes();
  }

  private shouldUseOptimizedProvider(node: ArxmlNode, filter?: TreeFilterConfig): boolean {
    if (!filter) {
      return false;
    }
    
    const childrenCount = this.getDescendantCount(node);
    return childrenCount > ArxmlTreeProvider.LARGE_TREE_THRESHOLD;
  }

  private getDescendantCount(node: ArxmlNode): number {
    let count = node.children.length;
    for (const child of node.children) {
      count += this.getDescendantCount(child);
    }
    return count;
  }

  private getCurrentFilter(): TreeFilterConfig | undefined {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      return undefined;
    }
    return this.filterByUri.get(activeDoc.uri.toString());
  }

  async setCustomViewForDocument(document: vscode.TextDocument, view?: CustomViewConfig): Promise<void> {
    if (document.languageId !== 'arxml') {
      return;
    }
    if (this.parsePromise) {
      await this.parsePromise;
    }
    const uriString = document.uri.toString();
    const previous = this.customViewByUri.get(uriString);
    this.customViewByUri.set(uriString, view);
    const prevOptions = resolveParseOptions(previous);
    const nextOptions = resolveParseOptions(view);
    const shouldReparse = prevOptions.parseMode !== nextOptions.parseMode
      || !sameList(prevOptions.nameTags, nextOptions.nameTags)
      || !sameList(prevOptions.nameTextTags, nextOptions.nameTextTags);
    if (shouldReparse) {
      const changedUris = await this.parseDocuments([document]);
      for (const uri of changedUris) {
        this.removeDocumentFromIndex(uri);
        this.indexDocument(uri);
        this.rebuildFilteredRootForDocument(uri);
      }
    } else {
      this.rebuildFilteredRootForDocument(uriString);
    }
    this._onDidChangeTreeData.fire();
  }

  async setFilterForDocument(document: vscode.TextDocument, filter?: TreeFilterConfig): Promise<void> {
    if (document.languageId !== 'arxml') {
      return;
    }
    const uriString = document.uri.toString();
    if (filter && isEmptyFilter(filter)) {
      this.filterByUri.delete(uriString);
    } else {
      this.filterByUri.set(uriString, filter);
    }

    const entry = this.parsedDocuments.get(uriString);
    if (entry && this.getDescendantCount(entry.root) > ArxmlTreeProvider.LARGE_TREE_THRESHOLD) {
      this.optimizedProvider.clearCache();
      this.optimizedProvider.debouncedApplyFilter(() => {
        this.rebuildFilteredRootForDocument(uriString);
        this._onDidChangeTreeData.fire();
      });
    } else {
      this.rebuildFilteredRootForDocument(uriString);
      this._onDidChangeTreeData.fire();
    }
  }

  getFilterForDocument(document: vscode.TextDocument): TreeFilterConfig | undefined {
    return this.filterByUri.get(document.uri.toString());
  }

  getCustomViewForDocument(document: vscode.TextDocument): CustomViewConfig | undefined {
    return this.customViewByUri.get(document.uri.toString());
  }

  async updateCustomView(view: CustomViewConfig): Promise<void> {
    const targets = Array.from(this.customViewByUri.entries())
      .filter(([, value]) => value?.id === view.id)
      .map(([uri]) => uri);
    for (const uri of targets) {
      this.customViewByUri.set(uri, view);
      const doc = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri);
      if (doc) {
        await this.setCustomViewForDocument(doc, view);
      } else {
        this.rebuildFilteredRootForDocument(uri);
      }
    }
  }

  async removeCustomViewId(id: string): Promise<void> {
    const targets = Array.from(this.customViewByUri.entries())
      .filter(([, value]) => value?.id === id)
      .map(([uri]) => uri);
    for (const uri of targets) {
      this.customViewByUri.set(uri, undefined);
      const doc = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri);
      if (doc) {
        await this.setCustomViewForDocument(doc, undefined);
      } else {
        this.rebuildFilteredRootForDocument(uri);
      }
    }
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
    
    let delay = 0;
    if (!forceImmediate) {
      const config = vscode.workspace.getConfiguration('arxmlTree');
      const baseDelay = config.get<number>('debounceDelay', 200);
      const adaptiveDebounce = config.get<boolean>('adaptiveDebounce', true);
      
      if (adaptiveDebounce && this.arxmlDocument) {
        const uriString = this.arxmlDocument.uri.toString();
        const entry = this.parsedDocuments.get(uriString);
        if (entry && this.getDescendantCount(entry.root) > ArxmlTreeProvider.LARGE_TREE_THRESHOLD) {
          delay = baseDelay * 2;
        } else {
          delay = baseDelay;
        }
      } else {
        delay = baseDelay;
      }
    }
    
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
      this.pendingRefresh = true;
      await this.parsePromise;
      return;
    }

    this.parsePromise = this.parseDocuments(targetDocuments)
      .then(changedUris => {
        if (changedUris.size > 0) {
          for (const uri of changedUris) {
            this.removeDocumentFromIndex(uri);
            this.indexDocument(uri);
            this.rebuildFilteredRootForDocument(uri);
          }
          this._onDidChangeTreeData.fire();
        }
      })
      .catch(error => {
        vscode.window.showErrorMessage(`Failed to parse ARXML file: ${(error as Error).message}`);
      })
      .finally(() => {
        this.parsePromise = undefined;
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.scheduleRefresh();
        }
      });

    await this.parsePromise;
  }

  private async ensureAllDocumentsParsed(): Promise<void> {
    const config = vscode.workspace.getConfiguration('arxmlTree');
    const refreshMode = config.get<string>('refreshMode', 'onChange');
    
    // For onSave/manual modes, only parse the active document to reduce overhead
    // Cross-file hover will use the stale index until a save or manual refresh
    let allArxmlDocs: vscode.TextDocument[];
    if (refreshMode === 'onChange') {
      // Collect all open ARXML documents
      allArxmlDocs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'arxml');
    } else {
      // onSave or manual: only parse the active document
      const activeDoc = this.getActiveArxmlDocument();
      allArxmlDocs = activeDoc ? [activeDoc] : [];
    }

    if (allArxmlDocs.length === 0) {
      return;
    }

    // Check which documents are not yet parsed or outdated
    const docsToParse: vscode.TextDocument[] = [];
    for (const doc of allArxmlDocs) {
      const uriString = doc.uri.toString();
      const cached = this.parsedDocuments.get(uriString);
      const options = resolveParseOptions(this.customViewByUri.get(uriString));
      if (!cached || cached.version !== doc.version || cached.parseMode !== options.parseMode || !sameList(cached.nameTags, options.nameTags) || !sameList(cached.nameTextTags, options.nameTextTags)) {
        docsToParse.push(doc);
      }
    }

    if (docsToParse.length > 0) {
      const changedUris = await this.parseDocuments(docsToParse);
      for (const uri of changedUris) {
        this.removeDocumentFromIndex(uri);
        this.indexDocument(uri);
      }
    } else if (this.arpathIndex.size === 0 && this.parsedDocuments.size > 0) {
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

  private async parseDocuments(documents: vscode.TextDocument[]): Promise<Set<string>> {
    const changedUris = new Set<string>();
    for (const document of documents) {
      const uriString = document.uri.toString();
      const cached = this.parsedDocuments.get(uriString);
      const options = resolveParseOptions(this.customViewByUri.get(uriString));
      if (cached && cached.version === document.version && cached.parseMode === options.parseMode && sameList(cached.nameTags, options.nameTags) && sameList(cached.nameTextTags, options.nameTextTags)) {
        continue;
      }
      try {
        const root = await parseArxmlDocument(
          document.getText(),
          document.uri,
          (offset) => document.positionAt(offset),
          {
            strict: options.parseMode === 'strict',
            nameTags: options.nameTags,
            nameTextTags: options.nameTextTags
          }
        );
        if (root) {
          root.name = path.basename(document.uri.fsPath);
          root.parent = undefined;
          this.parsedDocuments.set(uriString, {
            root,
            version: document.version,
            nameTags: options.nameTags,
            nameTextTags: options.nameTextTags,
            parseMode: options.parseMode
          });
          changedUris.add(uriString);
        } else if (this.parsedDocuments.has(uriString)) {
          this.parsedDocuments.delete(uriString);
          changedUris.add(uriString);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to parse ARXML file ${document.uri.fsPath}: ${(error as Error).message}`);
      }
    }

    return changedUris;
  }

  private rebuildArpathIndex(): void {
    const nextIndex: Map<string, ArxmlNode[]> = new Map();
    for (const { root } of this.parsedDocuments.values()) {
      this.indexTree(root, nextIndex);
    }
    this.arpathIndex = nextIndex;
  }

  private removeDocumentFromIndex(uri: string): void {
    const keys = this.docArpathKeys.get(uri);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      const nodes = this.arpathIndex.get(key);
      if (!nodes) {
        continue;
      }
      const filtered = nodes.filter(node => node.file.toString() !== uri);
      if (filtered.length === 0) {
        this.arpathIndex.delete(key);
      } else {
        this.arpathIndex.set(key, filtered);
      }
    }
    this.docArpathKeys.delete(uri);
  }

  private indexDocument(uri: string): void {
    const entry = this.parsedDocuments.get(uri);
    if (!entry) {
      return;
    }
    const keys = new Set<string>();
    const stack: ArxmlNode[] = [entry.root];
    while (stack.length) {
      const node = stack.pop()!;
      const variants = buildArpathVariants(node.arpath);
      for (const variant of variants) {
        keys.add(variant);
        const list = this.arpathIndex.get(variant) ?? [];
        list.push(node);
        this.arpathIndex.set(variant, list);
      }
      stack.push(...node.children);
    }
    this.docArpathKeys.set(uri, keys);
  }

  private getRootNodes(): ArxmlNode[] {
    return this.getParsedRootNodes();
  }

  private getParsedRootNodes(): ArxmlNode[] {
    return Array.from(this.parsedDocuments.entries())
      .map(([uri, entry]) => {
        return this.filteredRootsByUri.get(uri) ?? entry.root;
      })
      .filter((root): root is ArxmlNode => Boolean(root))
      .sort((a, b) => a.file.fsPath.localeCompare(b.file.fsPath));
  }

  private async getDocumentRoot(uriString: string): Promise<ArxmlNode | undefined> {
    if (!this.parsedDocuments.has(uriString)) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriString);
      if (doc) {
        const changedUris = await this.parseDocuments([doc]);
        for (const uri of changedUris) {
          this.removeDocumentFromIndex(uri);
          this.indexDocument(uri);
        }
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

  private rebuildFilteredRoots(): void {
    for (const uri of this.parsedDocuments.keys()) {
      this.rebuildFilteredRootForDocument(uri);
    }
  }

  private rebuildFilteredRootForDocument(uri: string): void {
    const entry = this.parsedDocuments.get(uri);
    if (!entry) {
      this.filteredRootsByUri.delete(uri);
      return;
    }
    const view = this.customViewByUri.get(uri);
    const filter = this.filterByUri.get(uri);
    const base = view ? buildFilteredTree(entry.root, view, undefined) : entry.root;
    const filtered = filter ? buildFilteredTreeWithFilter(base ?? entry.root, filter, undefined) : base;
    if (!view && !filter) {
      this.filteredRootsByUri.delete(uri);
      return;
    }
    this.filteredRootsByUri.set(uri, filtered ?? createEmptyRoot(entry.root));
  }

  getPerformanceStats(): { 
    optimizedCache: { cacheSize: number; loadingChunks: number };
    parsedDocuments: number;
    filteredRoots: number;
  } {
    return {
      optimizedCache: this.optimizedProvider.getCacheStats(),
      parsedDocuments: this.parsedDocuments.size,
      filteredRoots: this.filteredRootsByUri.size
    };
  }

  async preloadVisibleNodes(rootNode?: ArxmlNode): Promise<void> {
    if (!rootNode) {
      const roots = this.getRootNodes();
      if (roots.length === 0) {return;}
      rootNode = roots[0];
    }

    const filter = this.getCurrentFilter();
    if (filter && this.shouldUseOptimizedProvider(rootNode, filter)) {
      await this.optimizedProvider.preloadChildren(rootNode as LazyArxmlNode, filter);
    }
  }

  async getFilterResultCount(filter: TreeFilterConfig): Promise<number> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      return 0;
    }

    const entry = this.parsedDocuments.get(activeDoc.uri.toString());
    if (!entry) {
      return 0;
    }

    if (this.getDescendantCount(entry.root) > ArxmlTreeProvider.LARGE_TREE_THRESHOLD) {
      return await this.optimizedProvider.getFilteredNodeCount(entry.root as LazyArxmlNode, filter);
    } else {
      return this.countFilteredNodes(entry.root, filter);
    }
  }

  private countFilteredNodes(node: ArxmlNode, filter: TreeFilterConfig): number {
    let count = 0;
    if (matchesTreeFilter(node, filter)) {
      count++;
    }
    for (const child of node.children) {
      count += this.countFilteredNodes(child, filter);
    }
    return count;
  }

  async searchInTree(searchTerm: string, maxResults = 100): Promise<ArxmlNode[]> {
    const roots = this.getRootNodes();
    if (roots.length === 0) {return [];}

    const rootNode = roots[0];
    if (this.getDescendantCount(rootNode) > ArxmlTreeProvider.LARGE_TREE_THRESHOLD) {
      const results = await this.optimizedProvider.searchNodes(rootNode as LazyArxmlNode, searchTerm, maxResults);
      return results;
    } else {
      return this.searchNodesSynchronous(rootNode, searchTerm, maxResults);
    }
  }

  private searchNodesSynchronous(node: ArxmlNode, searchTerm: string, maxResults: number): ArxmlNode[] {
    const results: ArxmlNode[] = [];
    const stack: ArxmlNode[] = [node];
    const searchLower = searchTerm.toLowerCase();

    while (stack.length > 0 && results.length < maxResults) {
      const current = stack.pop()!;
      
      if (current.name.toLowerCase().includes(searchLower) || 
          current.arpath.toLowerCase().includes(searchLower) ||
          current.element.toLowerCase().includes(searchLower)) {
        results.push(current);
      }
      
      if (current.children && results.length < maxResults) {
        stack.push(...current.children);
      }
    }

    return results;
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

function buildFilteredTree(root: ArxmlNode, config: CustomViewConfig, parent: ArxmlNode | undefined): ArxmlNode | undefined {
  const children = root.children
    .map(child => buildFilteredTree(child, config, undefined))
    .filter((child): child is ArxmlNode => Boolean(child));

  const matches = matchesCustomView(root, config);
  if (!matches && children.length === 0) {
    return undefined;
  }

  const next: ArxmlNode = {
    name: root.name,
    arpath: root.arpath,
    element: root.element,
    file: root.file,
    range: root.range,
    uuid: root.uuid,
    parent,
    children: []
  };

  const sortedChildren = sortChildren(children, config.sort);
  next.children = sortedChildren.map(child => reparentTree(child, next));

  return next;
}

function resolveParseMode(view?: CustomViewConfig): CustomViewParseMode {
  return view?.parseMode ?? 'strict';
}

function resolveParseOptions(view?: CustomViewConfig): {
  parseMode: CustomViewParseMode;
  nameTags: string[];
  nameTextTags: string[];
} {
  return {
    parseMode: resolveParseMode(view),
    nameTags: view?.nameTags ?? ['SHORT-NAME'],
    nameTextTags: view?.nameTextTags ?? []
  };
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftNorm = left.map(value => value.toUpperCase()).sort();
  const rightNorm = right.map(value => value.toUpperCase()).sort();
  return leftNorm.every((value, index) => value === rightNorm[index]);
}

function createEmptyRoot(root: ArxmlNode): ArxmlNode {
  return {
    name: root.name,
    arpath: root.arpath,
    element: root.element,
    file: root.file,
    range: root.range,
    uuid: root.uuid,
    parent: undefined,
    children: []
  };
}


function buildFilteredTreeWithFilter(root: ArxmlNode, filter: TreeFilterConfig, parent: ArxmlNode | undefined): ArxmlNode | undefined {
  const children = root.children
    .map(child => buildFilteredTreeWithFilter(child, filter, undefined))
    .filter((child): child is ArxmlNode => Boolean(child));

  const matches = matchesTreeFilter(root, filter);
  if (!matches && children.length === 0) {
    return undefined;
  }

  const next: ArxmlNode = {
    name: root.name,
    arpath: root.arpath,
    element: root.element,
    file: root.file,
    range: root.range,
    uuid: root.uuid,
    parent,
    children: []
  };

  next.children = children.map(child => reparentTree(child, next));
  return next;
}

function matchesTreeFilter(node: ArxmlNode, filter: TreeFilterConfig): boolean {
  if (filter.name && !matchesPattern(node.name, filter.name, resolveFilterMode(filter, 'name'))) {
    return false;
  }
  if (filter.arpath && !matchesPattern(node.arpath, filter.arpath, resolveFilterMode(filter, 'arpath'))) {
    return false;
  }
  if (filter.element && !matchesPattern(node.element, filter.element, resolveFilterMode(filter, 'element'))) {
    return false;
  }
  return true;
}

function resolveFilterMode(filter: TreeFilterConfig, field: 'name' | 'arpath' | 'element'): TreeFilterMode {
  if (field === 'name' && filter.nameMode) {
    return filter.nameMode;
  }
  if (field === 'arpath' && filter.arpathMode) {
    return filter.arpathMode;
  }
  if (field === 'element' && filter.elementMode) {
    return filter.elementMode;
  }
  return filter.mode;
}

function matchesPattern(value: string, pattern: string, mode: TreeFilterMode): boolean {
  if (!pattern) {
    return true;
  }
  if (mode === 'contains') {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  if (mode === 'regex') {
    const regex = parseRegex(pattern);
    if (!regex) {
      return false;
    }
    return regex.test(value);
  }
  return globToRegex(pattern).test(value);
}

function parseRegex(pattern: string): RegExp | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/');
    const body = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1) || 'i';
    try {
      return new RegExp(body, flags);
    } catch {
      return undefined;
    }
  }
  try {
    return new RegExp(trimmed, 'i');
  } catch {
    return undefined;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexText = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(regexText, 'i');
}

function isEmptyFilter(filter: TreeFilterConfig): boolean {
  return !filter.name && !filter.arpath && !filter.element;
}

function reparentTree(node: ArxmlNode, parent: ArxmlNode | undefined): ArxmlNode {
  const next: ArxmlNode = {
    name: node.name,
    arpath: node.arpath,
    element: node.element,
    file: node.file,
    range: node.range,
    uuid: node.uuid,
    parent,
    children: []
  };
  next.children = node.children.map(child => reparentTree(child, next));
  return next;
}

function matchesCustomView(node: ArxmlNode, config: CustomViewConfig): boolean {
  const filters = config.filters ?? {};
  if (filters.arpathPrefix) {
    const prefix = normalizeArpath(filters.arpathPrefix);
    if (!normalizeArpath(node.arpath).startsWith(prefix)) {
      return false;
    }
  }

  if (filters.elementTags && filters.elementTags.length > 0) {
    if (!filters.elementTags.includes(node.element)) {
      return false;
    }
  }

  if (filters.textContains) {
    const needle = filters.textContains.toLowerCase();
    if (!node.name.toLowerCase().includes(needle)) {
      return false;
    }
  }

  if (filters.uuidFilter === 'present' && !node.uuid) {
    return false;
  }
  if (filters.uuidFilter === 'missing' && node.uuid) {
    return false;
  }

  return true;
}

function sortChildren(children: ArxmlNode[], sort?: CustomViewSort): ArxmlNode[] {
  if (!sort) {
    return children;
  }
  const sorted = [...children];
  if (sort === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'arpath') {
    sorted.sort((a, b) => a.arpath.localeCompare(b.arpath));
  }
  return sorted;
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
