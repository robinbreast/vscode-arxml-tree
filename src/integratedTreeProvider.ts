import * as vscode from 'vscode';
import { ArxmlNode } from './arxmlNode';
import { ArxmlTreeProvider, TreeFilterConfig, TreeFilterMode } from './treeProvider';
import { CrossFileSearchProvider, WorkspaceSearchResult, CrossFileSearchResult } from './crossFileSearchProvider';
import { SearchHistoryStore } from './searchHistoryStore';
import { SavedFiltersStore } from './savedFiltersStore';
import { CustomViewStore, CustomViewConfig } from './customViewStore';

export interface SearchableTreeItem extends vscode.TreeItem {
  searchable?: boolean;
  isSearchResult?: boolean;
  originalNode?: ArxmlNode;
  filePath?: string;
  recentId?: string;
  recentFilter?: TreeFilterConfig;
}

export class IntegratedTreeProvider implements vscode.TreeDataProvider<ArxmlNode | SearchableTreeItem>, vscode.Disposable {
  private _onDidChangeTreeData: vscode.EventEmitter<ArxmlNode | SearchableTreeItem | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<ArxmlNode | SearchableTreeItem | undefined | void> = this._onDidChangeTreeData.event;

  private arxmlTreeProvider: ArxmlTreeProvider;
  private crossFileSearchProvider: CrossFileSearchProvider;
  private searchHistoryStore: SearchHistoryStore;
  private savedFiltersStore: SavedFiltersStore;
  private customViewStore: CustomViewStore;

  private currentFilter: TreeFilterConfig | undefined;
  private draftFilter: TreeFilterConfig = {
    mode: 'contains',
    nameMode: 'contains',
    arpathMode: 'contains',
    elementMode: 'contains'
  };
  private activeDocumentFilter: TreeFilterConfig | undefined;
  private activeCustomView: CustomViewConfig | undefined;
  private isWorkspaceSearchMode: boolean = false;
  private workspaceResults: WorkspaceSearchResult | undefined;
  private searchControlsVisible: boolean = true;
  private searchInProgress: boolean = false;
  private disposables: vscode.Disposable[] = [];
  private filterControlsNode: SearchableTreeItem = {
    label: 'Filter Controls',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    searchable: true,
    contextValue: 'filterControlsRoot',
    iconPath: new vscode.ThemeIcon('filter')
  };
  private viewControlsNode: SearchableTreeItem = {
    label: 'View Controls',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    searchable: true,
    contextValue: 'viewControlsRoot',
    iconPath: new vscode.ThemeIcon('layout')
  };
  private filesNode: SearchableTreeItem = {
    label: 'Files',
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    searchable: true,
    contextValue: 'arxmlFilesRoot',
    iconPath: new vscode.ThemeIcon('files')
  };
  private recentFiltersNode: SearchableTreeItem = {
    label: 'Recent Filters',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    searchable: true,
    contextValue: 'recentFiltersRoot'
  };
  private customViewsNode: SearchableTreeItem = {
    label: 'Custom Views',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    searchable: true,
    contextValue: 'customViewsRoot'
  };

  constructor(
    arxmlTreeProvider: ArxmlTreeProvider,
    crossFileSearchProvider: CrossFileSearchProvider,
    searchHistoryStore: SearchHistoryStore,
    savedFiltersStore: SavedFiltersStore,
    customViewStore: CustomViewStore
  ) {
    this.arxmlTreeProvider = arxmlTreeProvider;
    this.crossFileSearchProvider = crossFileSearchProvider;
    this.searchHistoryStore = searchHistoryStore;
    this.savedFiltersStore = savedFiltersStore;
    this.customViewStore = customViewStore;

    this.disposables.push(
      this.arxmlTreeProvider.onDidChangeTreeData(() => {
        if (!this.isWorkspaceSearchMode) {
          this._onDidChangeTreeData.fire();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.syncActiveDocumentState();
      })
    );
    this.syncActiveDocumentState();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.arxmlTreeProvider.dispose();
    this.crossFileSearchProvider.dispose();
  }

  async getChildren(element?: ArxmlNode | SearchableTreeItem): Promise<(ArxmlNode | SearchableTreeItem)[]> {
    if (element && 'searchable' in element) {
      if (element.contextValue === 'filterControlsRoot') {
        return this.getSearchControlItems();
      }
      if (element.contextValue === 'viewControlsRoot') {
        return this.getViewControlItems();
      }
      if (element.contextValue === 'customViewsRoot') {
        return this.getCustomViewItems();
      }
      if (element.contextValue === 'recentFiltersRoot') {
        return this.getRecentFilterItems();
      }
      if (element.contextValue === 'filterCriteriaRoot') {
        return this.getFilterCriteriaItems();
      }
      if (element.contextValue === 'arxmlFilesRoot') {
        return this.arxmlTreeProvider.getChildren();
      }
      return [];
    }

    if (this.isWorkspaceSearchMode && this.workspaceResults) {
      if (!element && this.searchControlsVisible) {
        const filterHeader = this.createFilterControlsHeader();
        const viewHeader = this.createViewControlsHeader();
        const results = await this.getWorkspaceSearchChildren();
        return [filterHeader, viewHeader, ...results];
      }
      return this.getWorkspaceSearchChildren(element);
    }

    if (this.searchControlsVisible && !element) {
      const filterHeader = this.createFilterControlsHeader();
      const viewHeader = this.createViewControlsHeader();
      const filesGroup = this.createFilesGroupHeader();
      return [filterHeader, viewHeader, filesGroup];
    }

    if (!this.searchControlsVisible && !element) {
      return [this.createFilesGroupHeader()];
    }

    return this.arxmlTreeProvider.getChildren(element as ArxmlNode);
  }

  getTreeItem(element: ArxmlNode | SearchableTreeItem): vscode.TreeItem {
    if ('searchable' in element) {
      return element;
    }

    const treeItem = this.arxmlTreeProvider.getTreeItem(element as ArxmlNode);
    
    if (this.activeDocumentFilter) {
      const node = element as ArxmlNode;
      const matchesFilter = this.nodeMatchesFilter(node);
      if (matchesFilter) {
        treeItem.iconPath = new vscode.ThemeIcon('search', new vscode.ThemeColor('charts.yellow'));
        treeItem.description = 'Match';
      }
    }

    return treeItem;
  }

  getParent(element: ArxmlNode | SearchableTreeItem): ArxmlNode | SearchableTreeItem | undefined {
    if ('searchable' in element) {
      return undefined;
    }
    return this.arxmlTreeProvider.getParent(element as ArxmlNode);
  }

  private async getWorkspaceSearchChildren(element?: ArxmlNode | SearchableTreeItem): Promise<SearchableTreeItem[]> {
    if (!this.workspaceResults) {
      return [];
    }

    if (!element) {
      const items: SearchableTreeItem[] = [
        this.createSearchSummaryItem(),
        ...this.workspaceResults.files.map(file => this.createFileResultItem(file))
      ];
      return items;
    }

    if (element && 'filePath' in element && element.filePath) {
      const fileResult = this.workspaceResults.files.find(f => f.file.fsPath === element.filePath);
      if (fileResult) {
        return fileResult.matches.slice(0, 50).map(match => this.createMatchItem(match, fileResult.file));
      }
    }

    return [];
  }

  private async getSearchControlItems(): Promise<SearchableTreeItem[]> {
    const items: SearchableTreeItem[] = [];

    const criteriaItems = await this.getFilterCriteriaItems();
    items.push(...criteriaItems, this.recentFiltersNode);

    return items;
  }

  private createFilterControlsHeader(): SearchableTreeItem {
    const activeLabel = this.activeDocumentFilter ? 'On' : 'Off';
    this.filterControlsNode.label = this.searchInProgress ? 'Filtering...' : `Filter Controls (${activeLabel})`;
    this.filterControlsNode.command = undefined;
    this.filterControlsNode.iconPath = this.activeDocumentFilter
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
    return this.filterControlsNode;
  }

  private createViewControlsHeader(): SearchableTreeItem {
    const currentLabel = this.activeCustomView?.name ?? 'Default';
    this.viewControlsNode.label = `View Controls (${currentLabel})`;
    this.viewControlsNode.command = undefined;
    return this.viewControlsNode;
  }

  private async getViewControlItems(): Promise<SearchableTreeItem[]> {
    return [
      this.customViewsNode
    ];
  }

  private async getCustomViewItems(): Promise<SearchableTreeItem[]> {
    const views = await this.customViewStore.list();
    if (views.length === 0) {
      return [
        {
        label: 'No custom views',
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        searchable: true,
        contextValue: 'customViewEmpty'
        }
      ];
    }

    return views.map(view => ({
      label: view.name,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      searchable: true,
      contextValue: 'customViewItem',
      command: {
        command: 'arxml-integrated-tree.applyCustomViewById',
        title: 'Apply Custom View',
        arguments: [view.id]
      }
    }));
  }

  private createFilesGroupHeader(): SearchableTreeItem {
    return this.filesNode;
  }

  private async getRecentFilterItems(): Promise<SearchableTreeItem[]> {
    const recentSearches = await this.searchHistoryStore.getHistory();
    if (recentSearches.length === 0) {
      return [
        {
          label: 'No recent filters',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          searchable: true,
          contextValue: 'recentSearch'
        }
      ];
    }

    return recentSearches.slice(0, 20).map((entry, index) => ({
      label: `${index + 1}. ${this.formatFilterForDisplay(entry.filter)}`,
      command: {
        command: 'arxml-integrated-tree.applyRecentSearch',
        title: 'Apply Recent Search',
        arguments: [entry.filter, entry.id]
      },
      iconPath: new vscode.ThemeIcon('history'),
      searchable: true,
      contextValue: 'recentSearch',
      recentId: entry.id,
      recentFilter: entry.filter
    }));
  }

  private async getFilterCriteriaItems(): Promise<SearchableTreeItem[]> {
    const draft = this.draftFilter;
    const nameModeLabel = this.formatModeLabel(this.resolveFieldMode(draft, 'name'));
    const arpathModeLabel = this.formatModeLabel(this.resolveFieldMode(draft, 'arpath'));
    const elementModeLabel = this.formatModeLabel(this.resolveFieldMode(draft, 'element'));
    return [
      {
        label: `Name: ${draft.name ?? '—'}`,
        description: nameModeLabel,
        command: {
          command: 'arxml-integrated-tree.editFilterName',
          title: 'Edit Name Filter'
        },
        searchable: true,
        contextValue: 'filterName'
      },
      {
        label: `ARPATH: ${draft.arpath ?? '—'}`,
        description: arpathModeLabel,
        command: {
          command: 'arxml-integrated-tree.editFilterArpath',
          title: 'Edit ARPATH Filter'
        },
        searchable: true,
        contextValue: 'filterArpath'
      },
      {
        label: `Element: ${draft.element ?? '—'}`,
        description: elementModeLabel,
        command: {
          command: 'arxml-integrated-tree.editFilterElement',
          title: 'Edit Element Filter'
        },
        searchable: true,
        contextValue: 'filterElement'
      }
    ];
  }

  private createSearchSummaryItem(): SearchableTreeItem {
    const summary = this.workspaceResults!;
    return {
      label: `📊 Results: ${summary.totalMatches} matches in ${summary.totalFiles} files (${summary.searchTime}ms)`,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      searchable: true,
      contextValue: 'searchSummary',
      tooltip: `Found ${summary.totalMatches} matches across ${summary.totalFiles} ARXML files in ${summary.searchTime}ms`
    };
  }

  private createFileResultItem(fileResult: CrossFileSearchResult): SearchableTreeItem {
    const fileName = vscode.workspace.asRelativePath(fileResult.file);
    return {
      label: `📄 ${fileName}`,
      description: `${fileResult.totalCount} matches`,
      collapsibleState: fileResult.totalCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      searchable: true,
      filePath: fileResult.file.fsPath,
      contextValue: 'searchFileResult',
      command: fileResult.totalCount === 1 ? {
        command: 'vscode.open',
        arguments: [fileResult.file],
        title: 'Open File'
      } : undefined,
      resourceUri: fileResult.file
    };
  }

  private createMatchItem(match: ArxmlNode, file: vscode.Uri): SearchableTreeItem {
    return {
      label: match.name,
      description: `${match.element} - Line ${match.range.start.line + 1}`,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      searchable: true,
      isSearchResult: true,
      originalNode: match,
      contextValue: 'searchMatch',
      command: {
        command: 'arxml-integrated-tree.revealSearchResult',
        arguments: [match, file],
        title: 'Reveal in Editor'
      },
      iconPath: new vscode.ThemeIcon('symbol-' + this.getIconForElement(match.element)),
      tooltip: `ARPATH: ${match.arpath}\nElement: ${match.element}\nFile: ${vscode.workspace.asRelativePath(file)}\nLine: ${match.range.start.line + 1}`
    };
  }

  private getIconForElement(element: string): string {
    const iconMap: { [key: string]: string } = {
      'AUTOSAR': 'package',
      'ECUDOC': 'file',
      'MODULE': 'symbol-module',
      'CONTAINER': 'folder',
      'PARAMETER': 'symbol-parameter',
      'REFERENCE': 'references'
    };
    return iconMap[element] || 'symbol-property';
  }

  private nodeMatchesFilter(node: ArxmlNode): boolean {
    if (!this.activeDocumentFilter) {
      return false;
    }

    if (this.activeDocumentFilter.name) {
      const nameMatches = this.matchesNameFilter(
        node.name,
        this.activeDocumentFilter.name,
        this.resolveFieldMode(this.activeDocumentFilter, 'name')
      );
      if (!nameMatches) {
        return false;
      }
    }

    if (this.activeDocumentFilter.arpath) {
      if (!this.matchesNameFilter(
        node.arpath,
        this.activeDocumentFilter.arpath,
        this.resolveFieldMode(this.activeDocumentFilter, 'arpath')
      )) {
        return false;
      }
    }

    if (this.activeDocumentFilter.element) {
      if (!this.matchesNameFilter(
        node.element,
        this.activeDocumentFilter.element,
        this.resolveFieldMode(this.activeDocumentFilter, 'element')
      )) {
        return false;
      }
    }

    return true;
  }

  private matchesNameFilter(name: string, filterName: string, mode: TreeFilterMode): boolean {
    switch (mode) {
      case 'contains':
        return name.toLowerCase().includes(filterName.toLowerCase());
      case 'regex':
        try {
          const regex = new RegExp(filterName, 'i');
          return regex.test(name);
        } catch {
          return false;
        }
      case 'glob':
        return this.globMatch(name, filterName);
      default:
        return false;
    }
  }

  private globMatch(text: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return regex.test(text);
    } catch {
      return false;
    }
  }

  private resolveFieldMode(filter: TreeFilterConfig, field: 'name' | 'arpath' | 'element'): TreeFilterMode {
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

  private formatFilterForDisplay(filter: TreeFilterConfig): string {
    const parts = [];
    const nameMode = this.resolveFieldMode(filter, 'name');
    const arpathMode = this.resolveFieldMode(filter, 'arpath');
    const elementMode = this.resolveFieldMode(filter, 'element');
    if (filter.name) {
      parts.push(`name(${nameMode}):${filter.name}`);
    }
    if (filter.arpath) {
      parts.push(`path(${arpathMode}):${filter.arpath}`);
    }
    if (filter.element) {
      parts.push(`element(${elementMode}):${filter.element}`);
    }
    return parts.join(', ') || 'Empty filter';
  }

  async applyCurrentFileFilter(
    filter: TreeFilterConfig,
    options?: { skipHistory?: boolean; silent?: boolean }
  ): Promise<void> {
    this.currentFilter = filter;
    this.activeDocumentFilter = filter;
    this.draftFilter = { ...filter };
    this.isWorkspaceSearchMode = false;
    this.workspaceResults = undefined;

    if (!options?.skipHistory) {
      await this.searchHistoryStore.addSearch(filter);
    }
    
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && activeDoc.languageId === 'arxml') {
      await this.arxmlTreeProvider.setFilterForDocument(activeDoc, filter);
    }

    this._onDidChangeTreeData.fire();
    
    if (!options?.silent) {
      vscode.window.showInformationMessage(
        `Applied filter: ${this.formatFilterForDisplay(filter)}`
      );
    }
  }

  async applyWorkspaceSearch(filter: TreeFilterConfig): Promise<void> {
    this.currentFilter = filter;
    this.draftFilter = { ...filter };
    this.isWorkspaceSearchMode = true;
    this.searchInProgress = true;
    this._onDidChangeTreeData.fire();

    try {
      await this.searchHistoryStore.addSearch(filter);

      this.workspaceResults = await this.crossFileSearchProvider.searchWorkspace(
        filter,
        (progress) => {
          vscode.window.showInformationMessage(
            `Filtering: ${progress.files} files processed, ${progress.matches} matches found`
          );
        }
      );

      vscode.window.showInformationMessage(
        `Workspace filter completed: ${this.workspaceResults.totalMatches} matches in ${this.workspaceResults.totalFiles} files`
      );
    } catch (error) {
      this.workspaceResults = undefined;
      vscode.window.showErrorMessage(`Workspace filter failed: ${error}`);
    } finally {
      this.searchInProgress = false;
      this._onDidChangeTreeData.fire();
    }
  }

  async clearFilter(): Promise<void> {
    this.currentFilter = undefined;
    this.activeDocumentFilter = undefined;
    this.isWorkspaceSearchMode = false;
    this.workspaceResults = undefined;

    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && activeDoc.languageId === 'arxml') {
      await this.arxmlTreeProvider.setFilterForDocument(activeDoc, undefined);
    }

    this._onDidChangeTreeData.fire();
    vscode.window.showInformationMessage('Filter cleared');
  }

  updateDraftFilter(partial: Partial<TreeFilterConfig>): void {
    this.draftFilter = {
      ...this.draftFilter,
      ...partial
    };
    this._onDidChangeTreeData.fire();
  }

  setDraftFilter(filter: TreeFilterConfig): void {
    this.draftFilter = {
      ...filter,
      nameMode: filter.nameMode ?? filter.mode,
      arpathMode: filter.arpathMode ?? filter.mode,
      elementMode: filter.elementMode ?? filter.mode
    };
    this._onDidChangeTreeData.fire();
  }

  updateDraftFilterAndMaybeApply(partial: Partial<TreeFilterConfig>): void {
    this.updateDraftFilter(partial);
    if (this.activeDocumentFilter) {
      void this.applyDraftToCurrentFile({ skipHistory: true, silent: true });
    }
  }

  getDraftFilter(): TreeFilterConfig {
    return { ...this.draftFilter };
  }

  getCurrentCustomView(): CustomViewConfig | undefined {
    return this.activeCustomView;
  }

  isDraftEmpty(): boolean {
    return !this.draftFilter.name && !this.draftFilter.arpath && !this.draftFilter.element;
  }

  async applyDraftToCurrentFile(options?: { skipHistory?: boolean; silent?: boolean }): Promise<void> {
    await this.applyCurrentFileFilter(this.draftFilter, options);
  }

  async applyDraftToWorkspace(): Promise<void> {
    await this.applyWorkspaceSearch(this.draftFilter);
  }

  refreshActiveDocumentState(): void {
    this.syncActiveDocumentState();
  }

  refreshControls(): void {
    this._onDidChangeTreeData.fire();
  }


  private syncActiveDocumentState(): void {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      this.activeDocumentFilter = undefined;
      this.activeCustomView = undefined;
      this._onDidChangeTreeData.fire();
      return;
    }
    this.activeDocumentFilter = this.arxmlTreeProvider.getFilterForDocument(activeDoc);
    this.activeCustomView = this.arxmlTreeProvider.getCustomViewForDocument(activeDoc);
    if (this.activeDocumentFilter) {
      this.draftFilter = {
        ...this.activeDocumentFilter,
        nameMode: this.activeDocumentFilter.nameMode ?? this.activeDocumentFilter.mode,
        arpathMode: this.activeDocumentFilter.arpathMode ?? this.activeDocumentFilter.mode,
        elementMode: this.activeDocumentFilter.elementMode ?? this.activeDocumentFilter.mode
      };
    } else if (this.draftFilter.name || this.draftFilter.arpath || this.draftFilter.element) {
      this.draftFilter = {
        mode: this.draftFilter.mode,
        nameMode: this.draftFilter.nameMode ?? this.draftFilter.mode,
        arpathMode: this.draftFilter.arpathMode ?? this.draftFilter.mode,
        elementMode: this.draftFilter.elementMode ?? this.draftFilter.mode
      };
    }
    this._onDidChangeTreeData.fire();
  }

  private formatModeLabel(mode: TreeFilterMode): string {
    switch (mode) {
      case 'regex':
        return 'Regex';
      case 'glob':
        return 'Glob';
      case 'contains':
      default:
        return 'Contains';
    }
  }

  toggleSearchControls(): void {
    this.searchControlsVisible = !this.searchControlsVisible;
    this._onDidChangeTreeData.fire();
  }

  showSearchControls(): void {
    this.searchControlsVisible = true;
    this._onDidChangeTreeData.fire();
  }

  hideSearchControls(): void {
    this.searchControlsVisible = false;
    this._onDidChangeTreeData.fire();
  }

  getCurrentFilter(): TreeFilterConfig | undefined {
    return this.currentFilter;
  }

  isInWorkspaceSearchMode(): boolean {
    return this.isWorkspaceSearchMode;
  }

  getWorkspaceResults(): WorkspaceSearchResult | undefined {
    return this.workspaceResults;
  }

  async refreshCurrentView(): Promise<void> {
    if (this.isWorkspaceSearchMode && this.currentFilter) {
      await this.applyWorkspaceSearch(this.currentFilter);
    } else {
      this.arxmlTreeProvider.refresh();
      this._onDidChangeTreeData.fire();
    }
  }
}
