import * as vscode from 'vscode';
import { ArxmlTreeProvider, ArxmlNode, BookmarkTreeProvider } from './treeProvider';
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
      await revealPosition(node.file, node.range);
      // find node to select in tree view
      const treeNode = arxmlTreeProvider.findNode(node);
      if (treeNode) {
        // reveal node in tree view
        treeView.reveal(treeNode, { select: true, focus: true, expand: true });
      }
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.focusNode', async (node: ArxmlNode) => {
    if (node) {
      // find node to select in tree view
      const treeNode = arxmlTreeProvider.findNode(node);
      if (treeNode) {
        // reveal node in tree view
        treeView.reveal(treeNode, { select: false, focus: true, expand: true });
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
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.gotoNode', async (arpath: string) => {
    const node = await arxmlTreeProvider.findNodeWithArPath(arpath);
    if (node) {
      await revealPosition(node.file, node.range);
      // reveal node in tree view
      treeView.reveal(node, { select: true, focus: true, expand: true });
    } else {
      vscode.window.showInformationMessage(`Node with ARPath ${arpath} not found`);
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

async function revealPosition(uri: vscode.Uri, range: vscode.Range, highlightColor: string = 'rgba(0, 0, 255, 0.2)'): Promise<void> {
  let document: vscode.TextDocument | undefined = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());

  if (!document) {
    document = await vscode.workspace.openTextDocument(uri);
  }
  await vscode.window.showTextDocument(document, { selection: range, preview: false });
}