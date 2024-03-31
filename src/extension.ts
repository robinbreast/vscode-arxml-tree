import * as vscode from 'vscode';
import { ArxmlTreeProvider, ArxmlNode, BookmarkTreeProvider, ArxmlNodeInfo } from './treeProvider';
import { ArxmlHoverProvider } from './hoverProvider';

let treeView: vscode.TreeView<ArxmlNode>;
const arxmlTreeProvider = new ArxmlTreeProvider();
let bookmarkTreeView: vscode.TreeView<ArxmlNode>; // Rename bookmarkView to bookmarkTreeView to avoid confusion
const bookmarkTreeProvider = new BookmarkTreeProvider();
const hoverProvider = new ArxmlHoverProvider(arxmlTreeProvider);

export function activate(context: vscode.ExtensionContext) {
  treeView = vscode.window.createTreeView('arxml-tree-view', { treeDataProvider: arxmlTreeProvider });
  bookmarkTreeView = vscode.window.createTreeView('bookmark-tree-view', { treeDataProvider: bookmarkTreeProvider });

  treeView.onDidChangeSelection((event) => {
    const selectedItem = event.selection[0];
    if (selectedItem) {
      vscode.commands.executeCommand("arxml-tree-view.revealInFile", selectedItem);
    }
  });
  bookmarkTreeView.onDidChangeSelection((event) => {
    const selectedItem = event.selection[0];
    if (selectedItem) {
      vscode.commands.executeCommand("arxml-tree-view.revealInFile", selectedItem);
    }
  });

  // register hover provider
  context.subscriptions.push(vscode.languages.registerHoverProvider('arxml', hoverProvider));
  // Register commands for refresh and double click
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.refresh', () => arxmlTreeProvider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.revealInFile', async (node: ArxmlNode) => {
    if (node) {
      await revealPosition(node.file, node.lineNumber);
      // find node to select in tree view
      const treeNode = arxmlTreeProvider.findNode(node);
      if (treeNode) {
        // reveal node in tree view
        treeView.reveal(treeNode, { select: true, focus: true, expand: true });
      }
    }
  }));
  // Handle adding bookmark command
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.addBookmark', (node: ArxmlNode) => {
    if (node) {
      bookmarkTreeProvider.addBookmark(node);
      bookmarkTreeProvider.refresh();
    }
  }));

  // Handle selecting bookmark command
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.gotoNode', async (node: ArxmlNodeInfo) => {
    await revealPosition(vscode.Uri.parse(node.filepath), node.lineNumber);
    // find node to select in tree view
    const treeNode = arxmlTreeProvider.findNodeWithInfo(node);
    if (treeNode) {
      // reveal node in tree view
      treeView.reveal(treeNode, { select: true, focus: true, expand: true });
    }
  }));

  // Register event listeners for file changes and editor activations
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.languageId === 'arxml') {
      arxmlTreeProvider.refresh();
      bookmarkTreeProvider.refresh();
    }
  });

  vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId === 'arxml') {
      arxmlTreeProvider.refresh();
      bookmarkTreeProvider.refresh();
    }
  });

}

async function revealPosition(uri: vscode.Uri, lineNumber: number, highlightColor: string = 'rgba(0, 0, 255, 0.2)'): Promise<void> {
  let document: vscode.TextDocument | undefined = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());

  if (!document) {
    document = await vscode.workspace.openTextDocument(uri);
  }

  const position = new vscode.Position(lineNumber, 0);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: false });

  // Highlight the entire line using a decoration
  const line = document.lineAt(lineNumber);
  const range = new vscode.Range(line.range.start, line.range.end);
  const decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: highlightColor,
  });
  vscode.window.activeTextEditor?.setDecorations(decorationType, [range]);
}