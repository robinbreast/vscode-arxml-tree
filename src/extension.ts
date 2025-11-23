import * as vscode from 'vscode';
import { ArxmlTreeProvider, BookmarkTreeProvider } from './treeProvider';
import { ArxmlNode } from './arxmlNode';
import { ArxmlHoverProvider } from './hoverProvider';

export function activate(context: vscode.ExtensionContext) {
  let treeView: vscode.TreeView<ArxmlNode>;
  const arxmlTreeProvider = new ArxmlTreeProvider();
  context.subscriptions.push(arxmlTreeProvider);
  let bookmarkTreeView: vscode.TreeView<ArxmlNode>;
  const bookmarkTreeProvider = new BookmarkTreeProvider(context.workspaceState);
  const hoverProvider = new ArxmlHoverProvider(arxmlTreeProvider);

  treeView = vscode.window.createTreeView('arxml-tree-view', { treeDataProvider: arxmlTreeProvider });
  bookmarkTreeView = vscode.window.createTreeView('bookmark-tree-view', { treeDataProvider: bookmarkTreeProvider });
  context.subscriptions.push(treeView, bookmarkTreeView);

  context.subscriptions.push(treeView.onDidChangeSelection((event) => {
    const selectedItem = event.selection[0];
    if (selectedItem) {
      vscode.commands.executeCommand("arxml-tree-view.revealInFile", selectedItem);
    }
  }));
  context.subscriptions.push(bookmarkTreeView.onDidChangeSelection((event) => {
    const selectedItem = event.selection[0];
    if (selectedItem) {
      vscode.commands.executeCommand("arxml-tree-view.revealInFile", selectedItem);
    }
  }));

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
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.removeBookmark', (node: ArxmlNode) => {
    if (node) {
      bookmarkTreeProvider.removeBookmark(node);
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
  // handled inside providers
}

async function revealPosition(uri: vscode.Uri, range: vscode.Range): Promise<void> {
  let document: vscode.TextDocument | undefined = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());

  if (!document) {
    document = await vscode.workspace.openTextDocument(uri);
  }
  await vscode.window.showTextDocument(document, { selection: range, preview: false });
}
