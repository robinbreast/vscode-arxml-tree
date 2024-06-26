import * as vscode from 'vscode';
import * as fastXmlParser from 'fast-xml-parser';

export interface ArxmlNode {
  name: string;
  file: vscode.Uri;
  lineNumber: number;
  uuid?: string;
  parent?: ArxmlNode;
  children: ArxmlNode[];
}

export interface ArxmlNodeInfo {
  name: string;
  filepath: string;
  lineNumber: number;
  uuid: string;
}

export function getArxmlNodeInfo(node: ArxmlNode): ArxmlNodeInfo {
  return {
    name: node.name,
    filepath: node.file.fsPath,
    lineNumber: node.lineNumber,
    uuid: node.uuid ?? "",
  };
}

// Utility function for comparison
export function equalsArxmlNodes(node1: ArxmlNode, node2: ArxmlNode): boolean {
  return (
    node1.name === node2.name &&
    node1.file.fsPath === node2.file.fsPath &&
    node1.lineNumber === node2.lineNumber
  );
}

export class ArxmlTreeProvider implements vscode.TreeDataProvider<ArxmlNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | undefined | void> = new vscode.EventEmitter<ArxmlNode | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | undefined | void> = this._onDidChangeTreeData.event;

  private arxmlDocument: string = '';
  private rootNode: ArxmlNode | undefined;

  constructor() {
    vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument, this);
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
      this.refresh();
    }
  }

  private getElementPosition(name: string, uuid: string | undefined): number {
    let uuid_pattern = '';
    if (uuid) {
      uuid_pattern = 'UUID="' + uuid + '">[.\\s\\S]*';
    }
    const pattern = uuid_pattern + '<SHORT-NAME>' + name + '<\/SHORT-NAME>';
    const regex = new RegExp(pattern, 'g');
    const matches = this.arxmlDocument.match(regex);

    if (matches) {
      const matchIndex = this.arxmlDocument.indexOf(matches[0]);
      const linesBeforeMatch = this.arxmlDocument.substring(0, matchIndex).split('\n');
      return linesBeforeMatch.length;
    }
    return 0;
  }

  getTreeItem(element: ArxmlNode): vscode.TreeItem {
    return {
      label: element.name,
      collapsibleState: element.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      tooltip: `UUID: ${element.uuid}\nLine Number: ${element.lineNumber + 1}`
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

  findNodeWithInfo(node: ArxmlNodeInfo): ArxmlNode | undefined {
    return this.findNode(
      {
        name: node.name,
        file: vscode.Uri.parse(node.filepath),
        lineNumber: node.lineNumber,
        uuid: node.uuid,
        parent: undefined,
        children: [],
      }
    );
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

    const options = {
      ignoreAttributes: false,
      attributeNamePrefix: '@',
    };
    const parser = new fastXmlParser.XMLParser(options);
    const parsedXml = parser.parse(this.arxmlDocument);

    const rootNode: ArxmlNode = {
      name: '/',
      file: editor.document.uri,
      lineNumber: 0,
      uuid: undefined,
      parent: undefined,
      children: []
    };

    // Stack to keep track of nodes to process
    const stack: { node: any; parent: ArxmlNode }[] = [{ node: parsedXml, parent: rootNode }];

    while (stack.length > 0) {
      const { node, parent } = stack.pop()!;
      let currParent = parent;

      if (Array.isArray(node)) {
        for (const entry of node) {
          if (typeof entry === 'object') {
            stack.push({ node: entry, parent: currParent });
          }
        }
      } else if (typeof node === 'object') {
        if (Object.keys(node).includes('SHORT-NAME')) {
          const name = node['SHORT-NAME'];
          const uuid = node['@UUID'];
          const childNode: ArxmlNode = {
            name: name,
            file: editor.document.uri,
            lineNumber: this.getElementPosition(name, uuid),
            uuid: uuid,
            parent: currParent,
            children: []
          };
          currParent.children.push(childNode);
          currParent = childNode;
        }
        for (const key of Object.keys(node)) {
          if (typeof node[key] === 'object') {
            stack.push({ node: node[key], parent: currParent });
          }
        }
      }
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
      tooltip: `UUID: ${node.uuid}\nLine Number: ${node.lineNumber + 1}`
    };
  }

  getChildren(): Thenable<ArxmlNode[]> {
    return Promise.resolve(this.bookmarks);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  addBookmark(node: ArxmlNode) {
    if (!this.bookmarks.some(item => equalsArxmlNodes(item,node))) {
      this.bookmarks.push(node);
    }
  }
}