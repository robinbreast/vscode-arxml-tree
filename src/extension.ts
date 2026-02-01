import * as vscode from 'vscode';
import * as path from 'path';
import { ArxmlTreeProvider, BookmarkTreeProvider, TreeFilterConfig } from './treeProvider';
import { ArxmlNode } from './arxmlNode';
import { ArxmlHoverProvider } from './hoverProvider';
import { CustomViewStore, CustomViewConfig, CustomViewParseMode, CustomViewUuidFilter, CustomViewSort } from './customViewStore';
import { SearchHistoryStore } from './searchHistoryStore';
import { SavedFiltersStore } from './savedFiltersStore';
import { CrossFileSearchProvider } from './crossFileSearchProvider';
import { IntegratedTreeProvider, SearchableTreeItem } from './integratedTreeProvider';

export async function activate(context: vscode.ExtensionContext) {
  let treeView: vscode.TreeView<ArxmlNode | SearchableTreeItem>;
  const arxmlTreeProvider = new ArxmlTreeProvider();
  const crossFileSearchProvider = new CrossFileSearchProvider();
  let bookmarkTreeView: vscode.TreeView<ArxmlNode>;
  const bookmarkTreeProvider = new BookmarkTreeProvider(context.workspaceState);
  const hoverProvider = new ArxmlHoverProvider(arxmlTreeProvider);
  const customViewStore = new CustomViewStore(context);
  const searchHistoryStore = new SearchHistoryStore(context.workspaceState);
  const savedFiltersStore = new SavedFiltersStore(context.workspaceState);
  const integratedTreeProvider = new IntegratedTreeProvider(
    arxmlTreeProvider,
    crossFileSearchProvider,
    searchHistoryStore,
    savedFiltersStore,
    customViewStore
  );
  context.subscriptions.push(integratedTreeProvider);
  try {
    await customViewStore.ensureSeeded();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Custom views failed to initialize: ${message}`);
  }
  const viewSelectionsKey = 'arxmlTree.customViewSelections';

  treeView = vscode.window.createTreeView('arxml-integrated-view', { treeDataProvider: integratedTreeProvider });
  bookmarkTreeView = vscode.window.createTreeView('bookmark-tree-view', { treeDataProvider: bookmarkTreeProvider });
  context.subscriptions.push(treeView, bookmarkTreeView);
  await restoreSelectionsForOpenDocuments(context, viewSelectionsKey, customViewStore, arxmlTreeProvider);
  integratedTreeProvider.refreshActiveDocumentState();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (!editor || editor.document.languageId !== 'arxml') {
      return;
    }
    const selections = context.workspaceState.get<Record<string, string | null>>(viewSelectionsKey, {});
    const selection = selections[editor.document.uri.toString()];
    if (!selection) {
      await arxmlTreeProvider.setCustomViewForDocument(editor.document, undefined);
      integratedTreeProvider.refreshActiveDocumentState();
      return;
    }
    const view = await customViewStore.getById(selection);
    await arxmlTreeProvider.setCustomViewForDocument(editor.document, view);
    integratedTreeProvider.refreshActiveDocumentState();
  }));

  context.subscriptions.push(treeView.onDidChangeSelection((event) => {
    const selectedItem = event.selection[0];
    if (!selectedItem || 'searchable' in selectedItem) {
      return;
    }
    vscode.commands.executeCommand('arxml-tree-view.revealInFile', selectedItem);
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
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.refresh', () => integratedTreeProvider.refreshCurrentView()));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.refresh', () => integratedTreeProvider.refreshCurrentView()));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.toggleSearch', () => integratedTreeProvider.toggleSearchControls()));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.clearFilter', async () => {
    await integratedTreeProvider.clearFilter();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.showCurrentFileSearch', async () => {
    if (integratedTreeProvider.getCurrentFilter()) {
      await integratedTreeProvider.clearFilter();
      await updateToggleContext();
      return;
    }
    if (integratedTreeProvider.isDraftEmpty()) {
      vscode.window.showInformationMessage('Set filter criteria before applying.');
      return;
    }
    await integratedTreeProvider.applyDraftToCurrentFile();
    await updateToggleContext();
  }));
  const updateFilterModeContext = async (filter: TreeFilterConfig) => {
    const nameMode = filter.nameMode ?? filter.mode;
    const arpathMode = filter.arpathMode ?? filter.mode;
    const elementMode = filter.elementMode ?? filter.mode;
    await vscode.commands.executeCommand('setContext', 'arxmlTree.filterNameMode', nameMode);
    await vscode.commands.executeCommand('setContext', 'arxmlTree.filterArpathMode', arpathMode);
    await vscode.commands.executeCommand('setContext', 'arxmlTree.filterElementMode', elementMode);
  };

  const updateToggleContext = async () => {
    await vscode.commands.executeCommand('setContext', 'arxmlTree.filterActive', Boolean(integratedTreeProvider.getCurrentFilter()));
    await vscode.commands.executeCommand('setContext', 'arxmlTree.viewActive', Boolean(integratedTreeProvider.getCurrentCustomView()));
  };

  const applyDraftUpdate = async (partial: Partial<TreeFilterConfig>) => {
    integratedTreeProvider.updateDraftFilterAndMaybeApply(partial);
    await updateFilterModeContext(integratedTreeProvider.getDraftFilter());
    await updateToggleContext();
  };

  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.applyRecentSearch', async (filter: TreeFilterConfig) => {
    if (!filter) {
      return;
    }
    integratedTreeProvider.setDraftFilter(filter);
    await updateFilterModeContext(integratedTreeProvider.getDraftFilter());
    await integratedTreeProvider.applyCurrentFileFilter(filter);
    await updateToggleContext();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.editRecentFilter', async (item: SearchableTreeItem) => {
    if (!item?.recentFilter) {
      return;
    }
    integratedTreeProvider.setDraftFilter(item.recentFilter);
    await updateFilterModeContext(integratedTreeProvider.getDraftFilter());
    await updateToggleContext();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.removeRecentFilter', async (item: SearchableTreeItem) => {
    if (!item?.recentId) {
      return;
    }
    await searchHistoryStore.removeItem(item.recentId);
    integratedTreeProvider.refreshControls();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.clearRecentFilters', async () => {
    await searchHistoryStore.clearHistory();
    integratedTreeProvider.refreshControls();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.revealSearchResult', async (node: ArxmlNode, file?: vscode.Uri) => {
    if (!node) {
      return;
    }
    await revealPosition(file ?? node.file, node.range);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.editFilterName', async () => {
    const current = integratedTreeProvider.getDraftFilter();
    const value = await vscode.window.showInputBox({
      prompt: 'Name filter (optional)',
      value: current.name ?? ''
    });
    if (value === undefined) {
      return;
    }
    await applyDraftUpdate({ name: value.trim() || undefined });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.editFilterArpath', async () => {
    const current = integratedTreeProvider.getDraftFilter();
    const value = await vscode.window.showInputBox({
      prompt: 'ARPATH filter (optional)',
      value: current.arpath ?? ''
    });
    if (value === undefined) {
      return;
    }
    await applyDraftUpdate({ arpath: value.trim() || undefined });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.editFilterElement', async () => {
    const current = integratedTreeProvider.getDraftFilter();
    const value = await vscode.window.showInputBox({
      prompt: 'Element tag filter (optional)',
      value: current.element ?? ''
    });
    if (value === undefined) {
      return;
    }
    await applyDraftUpdate({ element: value.trim() || undefined });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setNameModeContains', async () => {
    await applyDraftUpdate({ nameMode: 'contains' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setNameModeContainsChecked', async () => {
    await applyDraftUpdate({ nameMode: 'contains' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setNameModeRegex', async () => {
    await applyDraftUpdate({ nameMode: 'regex' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setNameModeRegexChecked', async () => {
    await applyDraftUpdate({ nameMode: 'regex' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setNameModeGlob', async () => {
    await applyDraftUpdate({ nameMode: 'glob' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setNameModeGlobChecked', async () => {
    await applyDraftUpdate({ nameMode: 'glob' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setArpathModeContains', async () => {
    await applyDraftUpdate({ arpathMode: 'contains' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setArpathModeContainsChecked', async () => {
    await applyDraftUpdate({ arpathMode: 'contains' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setArpathModeRegex', async () => {
    await applyDraftUpdate({ arpathMode: 'regex' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setArpathModeRegexChecked', async () => {
    await applyDraftUpdate({ arpathMode: 'regex' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setArpathModeGlob', async () => {
    await applyDraftUpdate({ arpathMode: 'glob' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setArpathModeGlobChecked', async () => {
    await applyDraftUpdate({ arpathMode: 'glob' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setElementModeContains', async () => {
    await applyDraftUpdate({ elementMode: 'contains' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setElementModeContainsChecked', async () => {
    await applyDraftUpdate({ elementMode: 'contains' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setElementModeRegex', async () => {
    await applyDraftUpdate({ elementMode: 'regex' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setElementModeRegexChecked', async () => {
    await applyDraftUpdate({ elementMode: 'regex' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setElementModeGlob', async () => {
    await applyDraftUpdate({ elementMode: 'glob' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.setElementModeGlobChecked', async () => {
    await applyDraftUpdate({ elementMode: 'glob' });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.toggleCustomView', async () => {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      vscode.window.showInformationMessage('Open an ARXML file to apply custom views.');
      return;
    }
    if (integratedTreeProvider.getCurrentCustomView()) {
      await arxmlTreeProvider.setCustomViewForDocument(activeDoc, undefined);
      await persistSelection(context, viewSelectionsKey, activeDoc, null);
      integratedTreeProvider.refreshActiveDocumentState();
      await updateToggleContext();
      return;
    }
    const view = await resolveCustomView(customViewStore);
    if (!view) {
      return;
    }
    await arxmlTreeProvider.setCustomViewForDocument(activeDoc, view);
    await persistSelection(context, viewSelectionsKey, activeDoc, view.id);
    integratedTreeProvider.refreshActiveDocumentState();
    await updateToggleContext();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.toggleFileFilterOn', async () => {
    await vscode.commands.executeCommand('arxml-integrated-tree.showCurrentFileSearch');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.toggleFileFilterOff', async () => {
    await vscode.commands.executeCommand('arxml-integrated-tree.showCurrentFileSearch');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.toggleCustomViewOn', async () => {
    await vscode.commands.executeCommand('arxml-integrated-tree.toggleCustomView');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.toggleCustomViewOff', async () => {
    await vscode.commands.executeCommand('arxml-integrated-tree.toggleCustomView');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.selectCustomView', async () => {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      vscode.window.showInformationMessage('Open an ARXML file to apply custom views.');
      return;
    }
    const view = await resolveCustomView(customViewStore);
    if (!view) {
      return;
    }
    await arxmlTreeProvider.setCustomViewForDocument(activeDoc, view);
    await persistSelection(context, viewSelectionsKey, activeDoc, view.id);
    integratedTreeProvider.refreshActiveDocumentState();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-integrated-tree.applyCustomViewById', async (id: string) => {
    if (!id) {
      return;
    }
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      vscode.window.showInformationMessage('Open an ARXML file to apply custom views.');
      return;
    }
    if (id === 'default') {
      await arxmlTreeProvider.setCustomViewForDocument(activeDoc, undefined);
      await persistSelection(context, viewSelectionsKey, activeDoc, null);
      integratedTreeProvider.refreshActiveDocumentState();
      await updateToggleContext();
      return;
    }
    const view = await customViewStore.getById(id);
    if (!view) {
      vscode.window.showInformationMessage('Custom view not found.');
      return;
    }
    await arxmlTreeProvider.setCustomViewForDocument(activeDoc, view);
    await persistSelection(context, viewSelectionsKey, activeDoc, view.id);
    integratedTreeProvider.refreshActiveDocumentState();
    await updateToggleContext();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.clearCustomView', () => {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      return;
    }
    void arxmlTreeProvider.setCustomViewForDocument(activeDoc, undefined);
    void persistSelection(context, viewSelectionsKey, activeDoc, null);
  }));
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

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.addCustomView', async () => {
    const input = await promptCustomViewInput();
    if (!input) {
      return;
    }
    const created = await customViewStore.create(input);
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && activeDoc.languageId === 'arxml') {
      await arxmlTreeProvider.setCustomViewForDocument(activeDoc, created);
      await persistSelection(context, viewSelectionsKey, activeDoc, created.id);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.editCustomView', async () => {
    await openCustomViewsFile(customViewStore);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.removeCustomView', async () => {
    const target = await resolveCustomView(customViewStore);
    if (!target) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove custom view "${target.name}"?`,
      { modal: true },
      'Remove'
    );
    if (choice !== 'Remove') {
      return;
    }
    const removed = await customViewStore.remove(target.id);
    if (removed) {
      await arxmlTreeProvider.removeCustomViewId(target.id);
      await clearSelectionForViewId(context, viewSelectionsKey, target.id);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.applyCustomView', async () => {
    const target = await resolveCustomView(customViewStore);
    if (!target) {
      return;
    }
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      return;
    }
    await arxmlTreeProvider.setCustomViewForDocument(activeDoc, target);
    await persistSelection(context, viewSelectionsKey, activeDoc, target.id);
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

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.applyFilter', async () => {
    if (integratedTreeProvider.isDraftEmpty()) {
      vscode.window.showInformationMessage('Set filter criteria before applying.');
      return;
    }
    await integratedTreeProvider.applyDraftToCurrentFile();
    await updateToggleContext();
  }));

  await updateFilterModeContext(integratedTreeProvider.getDraftFilter());
  await updateToggleContext();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    void updateFilterModeContext(integratedTreeProvider.getDraftFilter());
    void updateToggleContext();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.clearFilter', async () => {
    await integratedTreeProvider.clearFilter();
    await updateToggleContext();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.exportAllCustomViews', async () => {
    try {
      const exportData = await customViewStore.exportAllViews();
      const defaultUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'arxml-custom-views.json'));
      
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
          'JSON Files': ['json'],
          'All Files': ['*']
        },
        saveLabel: 'Export Custom Views'
      });

      if (saveUri) {
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(exportData, 'utf8'));
        vscode.window.showInformationMessage(`Custom views exported to ${saveUri.fsPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to export custom views: ${message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.exportSelectedCustomViews', async () => {
    try {
      const allViews = await customViewStore.list();
      if (allViews.length === 0) {
        vscode.window.showInformationMessage('No custom views available to export.');
        return;
      }

      const items = allViews.map(view => ({
        label: view.name,
        description: view.description,
        id: view.id,
        picked: false
      }));

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select custom views to export'
      });

      if (!selected || selected.length === 0) {
        return;
      }

      const selectedIds = selected.map(item => item.id);
      const exportData = await customViewStore.exportSelectedViews(selectedIds);
      const defaultUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'arxml-custom-views.json'));

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
          'JSON Files': ['json'],
          'All Files': ['*']
        },
        saveLabel: 'Export Selected Custom Views'
      });

      if (saveUri) {
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(exportData, 'utf8'));
        vscode.window.showInformationMessage(`${selected.length} custom view(s) exported to ${saveUri.fsPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to export custom views: ${message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arxml-tree-view.importCustomViews', async () => {
    try {
      const openUri = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'JSON Files': ['json'],
          'All Files': ['*']
        },
        openLabel: 'Import Custom Views'
      });

      if (!openUri || openUri.length === 0) {
        return;
      }

      const sourceUri = openUri[0];

      const importOptions = await promptImportOptions();
      if (!importOptions) {
        return;
      }

      const result = await customViewStore.importFromFile(sourceUri, importOptions);
      
      let message = `Import completed: ${result.imported} imported, ${result.skipped} skipped`;
      if (result.errors.length > 0) {
        message += `, ${result.errors.length} errors`;
      }
      if (result.conflicts.length > 0) {
        message += `, ${result.conflicts.length} conflicts`;
      }

      if (result.errors.length > 0 || result.conflicts.length > 0) {
        vscode.window.showWarningMessage(message, 'Show Details').then(selection => {
          if (selection === 'Show Details') {
            showImportDetails(result);
          }
        });
      } else {
        vscode.window.showInformationMessage(message);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to import custom views: ${message}`);
    }
  }));

  // Register event listeners for file changes and editor activations
  // handled inside providers
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    const storageUri = customViewStore.getStorageFileUri();
    if (!storageUri || document.uri.toString() !== storageUri.toString()) {
      return;
    }
    await restoreSelectionsForOpenDocuments(context, viewSelectionsKey, customViewStore, arxmlTreeProvider);
  }));
}

async function persistSelection(
  context: vscode.ExtensionContext,
  key: string,
  document: vscode.TextDocument | undefined,
  viewId: string | null
): Promise<void> {
  if (!document || document.languageId !== 'arxml') {
    return;
  }
  const selections = context.workspaceState.get<Record<string, string | null>>(key, {});
  selections[document.uri.toString()] = viewId;
  await context.workspaceState.update(key, selections);
}

async function clearSelectionForViewId(
  context: vscode.ExtensionContext,
  key: string,
  viewId: string
): Promise<void> {
  const selections = context.workspaceState.get<Record<string, string | null>>(key, {});
  let changed = false;
  for (const entry of Object.keys(selections)) {
    if (selections[entry] === viewId) {
      selections[entry] = null;
      changed = true;
    }
  }
  if (changed) {
    await context.workspaceState.update(key, selections);
  }
}

async function openCustomViewsFile(store: CustomViewStore): Promise<void> {
  await store.ensureSeeded();
  const uri = store.getStorageFileUri();
  if (!uri) {
    vscode.window.showErrorMessage('No custom views file available.');
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function restoreSelectionsForOpenDocuments(
  context: vscode.ExtensionContext,
  key: string,
  store: CustomViewStore,
  provider: ArxmlTreeProvider
): Promise<void> {
  const selections = context.workspaceState.get<Record<string, string | null>>(key, {});
  const docs = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'arxml');
  for (const doc of docs) {
    const selection = selections[doc.uri.toString()];
    if (!selection) {
      continue;
    }
    const view = await store.getById(selection);
    await provider.setCustomViewForDocument(doc, view);
  }
}

async function resolveCustomView(store: CustomViewStore): Promise<CustomViewConfig | undefined> {
  const views = await store.list();
  if (views.length === 0) {
    vscode.window.showInformationMessage('No custom views available.');
    return undefined;
  }
  const items: Array<vscode.QuickPickItem & { view: CustomViewConfig }> = views.map(view => ({
    label: view.name,
    description: view.description,
    view
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a custom view' });
  return picked?.view;
}

async function promptCustomViewInput(existing?: CustomViewConfig): Promise<Omit<CustomViewConfig, 'id'> | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Custom view name',
    value: existing?.name ?? '',
    validateInput: value => value.trim() ? undefined : 'Name is required'
  });
  if (!name) {
    return undefined;
  }

  const description = await vscode.window.showInputBox({
    prompt: 'Description (optional)',
    value: existing?.description ?? ''
  });
  if (description === undefined) {
    return undefined;
  }

  const arpathPrefix = await vscode.window.showInputBox({
    prompt: 'ARPATH prefix filter (optional)',
    value: existing?.filters.arpathPrefix ?? ''
  });
  if (arpathPrefix === undefined) {
    return undefined;
  }

  const elementTagsRaw = await vscode.window.showInputBox({
    prompt: 'Element tags filter (comma-separated, optional)',
    value: existing?.filters.elementTags?.join(', ') ?? ''
  });
  if (elementTagsRaw === undefined) {
    return undefined;
  }
  const elementTags = parseList(elementTagsRaw);

  const textContains = await vscode.window.showInputBox({
    prompt: 'Name contains filter (optional)',
    value: existing?.filters.textContains ?? ''
  });
  if (textContains === undefined) {
    return undefined;
  }

  const uuidFilter = await pickUuidFilter(existing?.filters.uuidFilter);
  if (uuidFilter === 'cancelled') {
    return undefined;
  }

  const sort = await pickSort(existing?.sort);
  if (sort === 'cancelled') {
    return undefined;
  }

  const parseMode = await pickParseMode(existing?.parseMode);
  if (parseMode === 'cancelled') {
    return undefined;
  }

  return {
    name: name.trim(),
    description: description?.trim() || undefined,
    filters: {
      arpathPrefix: arpathPrefix?.trim() || undefined,
      elementTags,
      textContains: textContains?.trim() || undefined,
      uuidFilter: uuidFilter === 'any' ? undefined : uuidFilter,
    },
    sort: sort === 'none' ? undefined : sort,
    parseMode: parseMode === 'strict' ? undefined : parseMode,
  };
}


function parseList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value.split(',').map(entry => entry.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

async function pickUuidFilter(current?: CustomViewUuidFilter): Promise<CustomViewUuidFilter | 'any' | 'cancelled'> {
  const mapping: Array<{ label: string; value: CustomViewUuidFilter | 'any' }> = [
    { label: 'Any UUID', value: 'any' },
    { label: 'UUID present', value: 'present' },
    { label: 'UUID missing', value: 'missing' }
  ];
  const picked = await vscode.window.showQuickPick(mapping.map(entry => entry.label), {
    placeHolder: 'UUID filter'
  });
  if (!picked) {
    return 'cancelled';
  }
  return mapping.find(entry => entry.label === picked)?.value ?? (current ?? 'any');
}

async function pickSort(current?: CustomViewSort): Promise<CustomViewSort | 'none' | 'cancelled'> {
  const mapping: Array<{ label: string; value: CustomViewSort | 'none' }> = [
    { label: 'No sorting', value: 'none' },
    { label: 'Sort by name', value: 'name' },
    { label: 'Sort by ARPATH', value: 'arpath' }
  ];
  const picked = await vscode.window.showQuickPick(mapping.map(entry => entry.label), {
    placeHolder: 'Sort order'
  });
  if (!picked) {
    return 'cancelled';
  }
  return mapping.find(entry => entry.label === picked)?.value ?? (current ?? 'none');
}

async function pickParseMode(current?: CustomViewParseMode): Promise<CustomViewParseMode | 'cancelled'> {
  const mapping: Array<{ label: string; value: CustomViewParseMode }> = [
    { label: 'Strict XML parsing (default)', value: 'strict' },
    { label: 'Lenient XML parsing', value: 'lenient' }
  ];
  const picked = await vscode.window.showQuickPick(mapping.map(entry => entry.label), {
    placeHolder: 'Parser mode'
  });
  if (!picked) {
    return 'cancelled';
  }
  return mapping.find(entry => entry.label === picked)?.value ?? (current ?? 'strict');
}

async function revealPosition(uri: vscode.Uri, range: vscode.Range): Promise<void> {
  let document: vscode.TextDocument | undefined = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());

  if (!document) {
    document = await vscode.workspace.openTextDocument(uri);
  }
  await vscode.window.showTextDocument(document, { selection: range, preview: false });
}

async function promptImportOptions(): Promise<{ skipConflicts?: boolean; overwriteConflicts?: boolean; generateNewIds?: boolean } | undefined> {
  const conflictHandling = await vscode.window.showQuickPick([
    { label: 'Skip conflicts', description: 'Skip views that already exist', value: 'skip' },
    { label: 'Overwrite conflicts', description: 'Replace existing views with imported ones', value: 'overwrite' },
    { label: 'Ask for each conflict', description: 'Prompt for each conflicting view', value: 'ask' }
  ], {
    placeHolder: 'How should conflicts be handled?'
  });

  if (!conflictHandling) {
    return undefined;
  }

  const generateNewIds = await vscode.window.showQuickPick([
    { label: 'Keep original IDs', description: 'Use IDs from the import file', value: false },
    { label: 'Generate new IDs', description: 'Create new unique IDs for imported views', value: true }
  ], {
    placeHolder: 'ID handling for imported views'
  });

  if (generateNewIds === undefined) {
    return undefined;
  }

  return {
    skipConflicts: conflictHandling.value === 'skip',
    overwriteConflicts: conflictHandling.value === 'overwrite',
    generateNewIds: generateNewIds.value
  };
}

function showImportDetails(result: { imported: number; skipped: number; errors: Array<{ viewName: string; error: string }>; conflicts: Array<{ type: string; viewName: string; existingId: string; importedId: string }> }): void {
  const lines: string[] = [];
  
  lines.push(`Import Summary:`);
  lines.push(`- Imported: ${result.imported}`);
  lines.push(`- Skipped: ${result.skipped}`);
  lines.push(`- Errors: ${result.errors.length}`);
  lines.push(`- Conflicts: ${result.conflicts.length}`);
  lines.push('');

  if (result.errors.length > 0) {
    lines.push('Errors:');
    result.errors.forEach(error => {
      lines.push(`- ${error.viewName}: ${error.error}`);
    });
    lines.push('');
  }

  if (result.conflicts.length > 0) {
    lines.push('Conflicts:');
    result.conflicts.forEach(conflict => {
      lines.push(`- ${conflict.viewName}: ${conflict.type} (existing ID: ${conflict.existingId}, imported ID: ${conflict.importedId})`);
    });
  }

  const content = lines.join('\n');
  vscode.workspace.openTextDocument({
    content,
    language: 'plaintext'
  }).then(doc => {
    vscode.window.showTextDocument(doc, { preview: true });
  });
}
