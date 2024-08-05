import * as vscode from 'vscode';

export interface ArxmlNode {
  name: string;
  element: string;
  file: vscode.Uri;
  range: vscode.Range;
  uuid?: string;
  parent?: ArxmlNode;
  children: ArxmlNode[];
}

// Utility function for comparison
export function equalsArxmlNodes(node1: ArxmlNode, node2: ArxmlNode): boolean {
  return (
    node1.name === node2.name &&
    node1.element === node2.element &&
    node1.file.fsPath === node2.file.fsPath
  );
}

export class ArxmlTreeProvider implements vscode.TreeDataProvider<ArxmlNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | undefined | void> = new vscode.EventEmitter<ArxmlNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | undefined | void> = this._onDidChangeTreeData.event;

  private arxmlDocument: string | undefined;
  private rootNode: ArxmlNode | undefined;

  constructor() {
    vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this);
    vscode.window.onDidChangeTextEditorSelection(this.onDidChangeTextEditorSelection, this);
  }

  public async getRootNode(): Promise<ArxmlNode | undefined> {
    if (!this.rootNode) {
      this.rootNode = await this.buildArxmlTree();
    }
    return this.rootNode;
  }

  refresh(): void {
    this.buildArxmlTree().then(rootNode => {
      this.rootNode = rootNode;
      this._onDidChangeTreeData.fire();
    });
  }

  private onDidChangeTextDocument(event: vscode.TextDocumentChangeEvent): void {
    if (event.document.uri.fsPath.endsWith('.arxml')) {
      this.arxmlDocument = event.document.getText();
      this.currentHighlightRange = undefined;
      this.lastClickTime = 0;
      this.refresh();
    }
  }

  private lastClickTime: number = 0;
  private currentHighlightRange: vscode.Range | undefined;
  private readonly highlightType: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(0, 0, 255, 0.2)',
  });

  private onDidChangeTextEditorSelection(event: vscode.TextEditorSelectionChangeEvent): void {
    const editor = event.textEditor;
    if (editor.document.languageId === 'arxml') {
      const lineNumber = event.selections[0].active.line + 1; // Line numbers are 0-based, so add 1

      // Check if the current line is within the range of any tree node
      this.getRootNode().then(rootNode => {
        if (rootNode) {
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
          if (closestNode) {
            // Send the 'focusNode' command with the closest node as an argument
            vscode.commands.executeCommand('arxml-tree-view.focusNode', closestNode);

            // Check for double-click
            const currentTime = new Date().getTime();
            //if (this.lastClickTime !== 0 && currentTime - this.lastClickTime < 1000) { // 1s threshold for double-click
              editor.setDecorations(this.highlightType, [closestNode.range]);
              this.lastClickTime = 0;
           // }
            this.lastClickTime = currentTime;
          }
        }
      });
    }
  }

  getTreeItem(element: ArxmlNode): vscode.TreeItem {
    return {
      label: element.name,
      collapsibleState: element.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      tooltip: `UUID: ${element.uuid}\nLine: ${element.range.start.line + 1} ~ ${element.range.end.line + 1}`
    };
  }

  getParent(element: ArxmlNode): ArxmlNode | undefined {
    return element.parent;
  }

  getChildren(element?: ArxmlNode): Thenable<ArxmlNode[]> {
    if (element && element.children) {
      return Promise.resolve(element.children);
    } else {
      return this.getRootNode().then(rootNode => rootNode ? rootNode.children : []);
    }
  }

  findNode(node: ArxmlNode): ArxmlNode | undefined {
    if (!this.rootNode) {
      return undefined;
    }

    const stack: ArxmlNode[] = [this.rootNode];

    while (stack.length > 0) {
      const currentNode = stack.pop()!;

      if (equalsArxmlNodes(currentNode, node)) {
        return currentNode;
      }

      stack.push(...currentNode.children);
    }

    return undefined;
  }

  // Function to find the node corresponding to the link text (PATH)
  async findNodeWithArPath(targetLabel: string): Promise<ArxmlNode | undefined> {
    // Get the root node from the tree provider
    const rootNode = await this.getRootNode();

    if (!rootNode) {
      return undefined; // No root node found
    }

    // Split the target label by '/' to get the node labels
    const labels = targetLabel.split('/').filter(label => label.trim() !== '');

    let currentNode = rootNode;
    if (currentNode) {
      for (const label of labels) {
        if (!currentNode.children) {
          return undefined; // No children nodes found for the current node
        }
        // Find the child node with the matching label
        const foundNode = currentNode.children.find(node => node.name === label);
        if (!foundNode) {
          return undefined; // Child node with the given label not found
        }
        currentNode = foundNode; // Move to the next level
      }
    }

    return currentNode;
  }

  private async buildArxmlTree(): Promise<ArxmlNode | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'arxml') {
      return undefined;
    }

    this.arxmlDocument = editor.document.getText();

    if (!this.arxmlDocument) {
      vscode.window.showInformationMessage('No ARXML document found.');
      return undefined;
    }

    function* getLines(text: string): Generator<string> {
      let startIndex = 0;
      while (startIndex < text.length) {
        const endIndex = text.indexOf('\n', startIndex);
        if (endIndex === -1) {
          yield text.substring(startIndex);
          break;
        } else {
          yield text.substring(startIndex, endIndex);
          startIndex = endIndex + 1;
        }
      }
    }

    const rootNode: ArxmlNode = {
      name: '/',
      element: 'AUTOSAR',
      file: editor.document.uri,
      range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(this.arxmlDocument.length, 0)),
      uuid: undefined,
      parent: undefined,
      children: []
    };

    // Stack to keep track of nodes to process
    const stack: ArxmlNode[] = [];
    const lines = getLines(this.arxmlDocument || '');
    const regex = /<(?<element_name>[A-Za-z0-9-_]+)(?:[^>]*?UUID="(?<uuid>[0-9a-fA-F-]+)")?[^>]*?>(?<value>[^<]*)(?:<\/\k<element_name>>)?|<\/(?<closing_element>[A-Za-z0-9-_]+)>/gm;
    let lineNumber = 0;
    let previousLine = '';
    let currentNode = rootNode;

    for (const line of lines) {
      for (const match of line.matchAll(regex)) {
        if (match.groups?.element_name === 'SHORT-NAME') {
          const start = new vscode.Position(lineNumber - 1, 0);
          const childNode: ArxmlNode = {
            name: match.groups.value,
            element: '',
            file: editor.document.uri,
            range: new vscode.Range(start, start),
            uuid: undefined,
            parent: currentNode,
            children: []
          };
          currentNode.children.push(childNode);
          // Parse the previous line
          for (const prevMatch of previousLine.matchAll(regex)) {
            childNode.element = prevMatch.groups?.element_name || '';
            childNode.uuid = prevMatch.groups?.uuid || undefined;
          }
          stack.push(currentNode);
          currentNode = childNode;
        } else if (match.groups?.closing_element === currentNode.element) {
          const end = new vscode.Position(lineNumber, line.length);
          currentNode.range = new vscode.Range(currentNode.range.start, end);
          currentNode = stack.pop() || rootNode;
        }
      }
      previousLine = line;
      lineNumber++;
    }
    return rootNode;
  }

}

export class BookmarkTreeProvider implements vscode.TreeDataProvider<ArxmlNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | undefined | void> = new vscode.EventEmitter<ArxmlNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | undefined | void> = this._onDidChangeTreeData.event;
  private bookmarks: ArxmlNode[];

  constructor() {
    this.bookmarks = [];
  }

  getTreeItem(node: ArxmlNode): vscode.TreeItem {
    return {
      label: node.name,
      tooltip: `UUID: ${node.uuid}\nLine: ${node.range.start.line + 1} ~ ${node.range.end.line + 1}`
    };
  }

  getChildren(): Thenable<ArxmlNode[]> {
    return Promise.resolve(this.bookmarks);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  addBookmark(node: ArxmlNode) {
    if (!this.bookmarks.some(item => equalsArxmlNodes(item, node))) {
      this.bookmarks.push(node);
    }
  }
}