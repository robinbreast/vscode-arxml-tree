import * as vscode from 'vscode';
import { ArxmlTreeProvider, TreeFilterConfig, TreeFilterMode } from './treeProvider';
import { CustomViewStore } from './customViewStore';
import { SearchHistoryStore } from './searchHistoryStore';
import { SavedFiltersStore } from './savedFiltersStore';

export class SearchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'arxml-search-view';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly treeProvider: ArxmlTreeProvider,
    private readonly customViewStore: CustomViewStore,
    private readonly searchHistoryStore: SearchHistoryStore,
    private readonly savedFiltersStore: SavedFiltersStore,
    private readonly onApplyCustomView: (id?: string) => Promise<void>,
    private readonly onClearCustomView: () => Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'apply') {
        await this.applyFilter(message.payload);
      }
      if (message?.type === 'applyCustomView') {
        await this.onApplyCustomView(message.payload?.id);
      }
      if (message?.type === 'clearCustomView') {
        await this.onClearCustomView();
      }
      if (message?.type === 'clear') {
        await this.clearFilter();
      }
      if (message?.type === 'ready') {
        await this.postViews();
        await this.postSearchHistory();
        await this.postSavedFilters();
      }
      if (message?.type === 'applySearchHistory') {
        await this.applySearchHistoryItem(message.payload?.id);
      }
      if (message?.type === 'removeSearchHistory') {
        await this.removeSearchHistoryItem(message.payload?.id);
      }
      if (message?.type === 'clearSearchHistory') {
        await this.clearSearchHistory();
      }
      if (message?.type === 'saveFilter') {
        await this.saveCurrentFilter(message.payload?.name, message.payload?.description);
      }
      if (message?.type === 'applySavedFilter') {
        await this.applySavedFilter(message.payload?.id);
      }
      if (message?.type === 'deleteSavedFilter') {
        await this.deleteSavedFilter(message.payload?.id);
      }
      if (message?.type === 'renameSavedFilter') {
        await this.renameSavedFilter(message.payload?.id, message.payload?.name);
      }
      if (message?.type === 'currentFilter') {
        this.currentFilterBeingSaved = message.payload;
      }
      if (message?.type === 'exportAllCustomViews') {
        await vscode.commands.executeCommand('arxml-tree-view.exportAllCustomViews');
      }
      if (message?.type === 'exportSelectedCustomViews') {
        await vscode.commands.executeCommand('arxml-tree-view.exportSelectedCustomViews');
      }
      if (message?.type === 'importCustomViews') {
        await vscode.commands.executeCommand('arxml-tree-view.importCustomViews');
      }
    });
  }

  private async applyFilter(config: TreeFilterConfig): Promise<void> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      return;
    }
    
    await this.searchHistoryStore.addSearch(config);
    await this.postSearchHistory();
    
    await this.treeProvider.setFilterForDocument(activeDoc, config);
    
    try {
      const resultCount = await this.treeProvider.getFilterResultCount(config);
      this.view?.webview.postMessage({
        type: 'filterStats',
        payload: { resultCount, hasResults: resultCount > 0 }
      });
    } catch (error) {
      console.warn('Failed to get filter result count:', error);
    }
  }

  private async clearFilter(): Promise<void> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.languageId !== 'arxml') {
      return;
    }
    await this.treeProvider.setFilterForDocument(activeDoc, undefined);
    
    this.view?.webview.postMessage({
      type: 'filterStats',
      payload: { resultCount: -1, hasResults: false }
    });
  }

  private async postViews(): Promise<void> {
    if (!this.view) {
      return;
    }
    const views = await this.customViewStore.list();
    this.view.webview.postMessage({
      type: 'views',
      payload: views.map(view => ({ id: view.id, name: view.name }))
    });
  }

  private async postSearchHistory(): Promise<void> {
    if (!this.view) {
      return;
    }
    const history = await this.searchHistoryStore.getHistory();
    this.view.webview.postMessage({
      type: 'searchHistory',
      payload: history.map(item => ({ 
        id: item.id, 
        label: item.label,
        timestamp: item.timestamp 
      }))
    });
  }

  private async applySearchHistoryItem(id: string): Promise<void> {
    const history = await this.searchHistoryStore.getHistory();
    const item = history.find(h => h.id === id);
    if (item) {
      await this.applyFilter(item.filter);
      this.view?.webview.postMessage({
        type: 'setFilterValues',
        payload: item.filter
      });
    }
  }

  private async removeSearchHistoryItem(id: string): Promise<void> {
    await this.searchHistoryStore.removeItem(id);
    await this.postSearchHistory();
  }

  private async clearSearchHistory(): Promise<void> {
    await this.searchHistoryStore.clearHistory();
    await this.postSearchHistory();
  }

  private async postSavedFilters(): Promise<void> {
    if (!this.view) {
      return;
    }
    const savedFilters = await this.savedFiltersStore.getSavedFilters();
    this.view.webview.postMessage({
      type: 'savedFilters',
      payload: savedFilters.map(filter => ({
        id: filter.id,
        name: filter.name,
        description: filter.description,
        createdAt: filter.createdAt,
        lastUsed: filter.lastUsed
      }))
    });
  }

  private async saveCurrentFilter(name: string, description?: string): Promise<void> {
    if (!name?.trim()) {
      this.showValidationError('Please provide a name for the filter.');
      return;
    }

    if (name.trim().length > 100) {
      this.showValidationError('Filter name is too long (maximum 100 characters).');
      return;
    }

    if (description && description.trim().length > 500) {
      this.showValidationError('Filter description is too long (maximum 500 characters).');
      return;
    }

    const currentFilter = await this.getCurrentFilterFromWebview();
    if (!currentFilter || this.isEmptyFilter(currentFilter)) {
      this.showValidationError('No filter to save. Please set up a filter first.');
      return;
    }

    this.showLoadingState('Saving filter...');

    try {
      await this.savedFiltersStore.saveFilter(name.trim(), currentFilter, description?.trim());
      await this.postSavedFilters();
      this.hideLoadingState();
      vscode.window.showInformationMessage(`Filter "${name}" saved successfully.`);
    } catch (error) {
      this.hideLoadingState();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.showError(`Failed to save filter: ${errorMessage}`, 'Try Again', () => {
        this.saveCurrentFilter(name, description);
      });
    }
  }

  private async applySavedFilter(id: string): Promise<void> {
    const filter = await this.savedFiltersStore.getFilterById(id);
    if (filter) {
      await this.applyFilter(filter.filter);
      await this.savedFiltersStore.updateLastUsed(id);
      this.view?.webview.postMessage({
        type: 'setFilterValues',
        payload: filter.filter
      });
      await this.postSavedFilters();
    }
  }

  private async deleteSavedFilter(id: string): Promise<void> {
    try {
      await this.savedFiltersStore.deleteFilter(id);
      await this.postSavedFilters();
      vscode.window.showInformationMessage('Filter deleted successfully.');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete filter: ${error}`);
    }
  }

  private async renameSavedFilter(id: string, newName: string): Promise<void> {
    if (!newName?.trim()) {
      vscode.window.showErrorMessage('Please provide a valid name.');
      return;
    }

    try {
      await this.savedFiltersStore.renameFilter(id, newName.trim());
      await this.postSavedFilters();
      vscode.window.showInformationMessage('Filter renamed successfully.');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to rename filter: ${error}`);
    }
  }

  private currentFilterBeingSaved: TreeFilterConfig | undefined;

  private async getCurrentFilterFromWebview(): Promise<TreeFilterConfig | undefined> {
    this.currentFilterBeingSaved = undefined;
    this.view?.webview.postMessage({ type: 'getCurrentFilter' });
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(undefined);
      }, 1000);

      const checkFilter = () => {
        if (this.currentFilterBeingSaved !== undefined) {
          clearTimeout(timeout);
          resolve(this.currentFilterBeingSaved);
        } else {
          setTimeout(checkFilter, 50);
        }
      };
      
      checkFilter();
    });
  }

  private isEmptyFilter(filter: TreeFilterConfig): boolean {
    return !filter.name && !filter.arpath && !filter.element;
  }

  private showValidationError(message: string): void {
    this.view?.webview.postMessage({
      type: 'validationError',
      payload: { message }
    });
  }

  private showError(message: string, actionLabel?: string, action?: () => void): void {
    this.view?.webview.postMessage({
      type: 'error',
      payload: { message, actionLabel, hasAction: !!action }
    });

    if (actionLabel && action) {
      vscode.window.showErrorMessage(message, actionLabel).then(selection => {
        if (selection === actionLabel) {
          action();
        }
      });
    } else {
      vscode.window.showErrorMessage(message);
    }
  }

  private showLoadingState(message: string): void {
    this.view?.webview.postMessage({
      type: 'loading',
      payload: { loading: true, message }
    });
  }

  private hideLoadingState(): void {
    this.view?.webview.postMessage({
      type: 'loading',
      payload: { loading: false }
    });
  }

  async refreshViews(): Promise<void> {
    await this.postViews();
    await this.postSavedFilters();
    await this.postSearchHistory();
  }

  private showSuccess(message: string): void {
    this.view?.webview.postMessage({
      type: 'success',
      payload: { message }
    });
    vscode.window.showInformationMessage(message);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      margin: 0;
      padding: 12px;
    }
    .section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    input, select, button {
      font-family: var(--vscode-font-family);
    }
    input, select {
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row > * {
      flex: 1;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    button {
      padding: 6px 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-border);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
    }
    hr {
      border: none;
      border-top: 1px solid var(--vscode-editorWidget-border);
      margin: 8px 0;
    }
    .advanced {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-editorWidget-border);
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .advanced.show {
      display: flex;
    }
    .history-list {
      max-height: 120px;
      overflow-y: auto;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
    }
    .history-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .history-item:last-child {
      border-bottom: none;
    }
    .history-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .history-item-label {
      flex: 1;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .history-item-remove {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      margin-left: 4px;
      border-radius: 2px;
      font-size: 12px;
    }
    .history-item-remove:hover {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
    }
    .history-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }
    .history-actions button {
      padding: 2px 6px;
      font-size: 11px;
    }
    .saved-filters {
      max-height: 150px;
      overflow-y: auto;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
    }
    .saved-filter-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
    }
    .saved-filter-item:last-child {
      border-bottom: none;
    }
    .saved-filter-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .saved-filter-main {
      flex: 1;
      cursor: pointer;
      min-width: 0;
    }
    .saved-filter-name {
      font-size: 12px;
      font-weight: 500;
    }
    .saved-filter-description {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 1px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .saved-filter-actions {
      display: flex;
      gap: 2px;
      margin-left: 4px;
    }
    .saved-filter-action {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 11px;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .saved-filter-action:hover {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
    }
    .save-filter-form {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
    }
    .save-filter-row {
      display: flex;
      gap: 4px;
    }
    .save-filter-input {
      flex: 1;
      padding: 4px 6px;
      font-size: 12px;
    }
    .filter-stats {
      padding: 4px 8px;
      background: var(--vscode-editorWidget-background);
      border-radius: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      display: none;
    }
    .filter-stats.show {
      display: block;
    }
    .filter-stats.no-results {
      color: var(--vscode-inputValidation-warningForeground);
    }
    .notification {
      padding: 8px;
      margin: 4px 0;
      border-radius: 4px;
      font-size: 12px;
      display: none;
      align-items: center;
      gap: 8px;
    }
    .notification.show {
      display: flex;
    }
    .notification.error {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    .notification.warning {
      background: var(--vscode-inputValidation-warningBackground);
      color: var(--vscode-inputValidation-warningForeground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
    }
    .notification.success {
      background: var(--vscode-inputValidation-infoBackground);
      color: var(--vscode-inputValidation-infoForeground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .notification.loading {
      background: var(--vscode-editorWidget-background);
      color: var(--vscode-editorWidget-foreground);
      border: 1px solid var(--vscode-editorWidget-border);
    }
    .notification-message {
      flex: 1;
    }
    .notification-close {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0;
      font-size: 14px;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .loading-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--vscode-progressBar-background);
      border-top: 2px solid var(--vscode-progressBar-foreground);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .input-error {
      border-color: var(--vscode-inputValidation-errorBorder) !important;
      background-color: var(--vscode-inputValidation-errorBackground) !important;
    }
  </style>
</head>
<body>
    <div class="section">
      <div id="notifications" class="notification">
        <div class="loading-spinner" id="loadingSpinner" style="display: none;"></div>
        <div class="notification-message" id="notificationMessage"></div>
        <button class="notification-close" id="notificationClose">×</button>
      </div>
      <div>
        <label for="customView">Custom view</label>
        <div class="row">
          <select id="customView"></select>
          <button id="editCustomView" class="secondary">Edit</button>
          <button id="clearCustomView" class="secondary">Clear</button>
        </div>
        <div class="row" style="margin-top: 4px;">
          <button id="exportAllViews" class="secondary">Export All</button>
          <button id="exportSelectedViews" class="secondary">Export Selected</button>
          <button id="importViews" class="secondary">Import</button>
        </div>
      </div>
      <hr />
      <div>
        <label for="searchHistory">Search History</label>
        <div class="history-list" id="searchHistory">
        </div>
        <div class="history-actions">
          <button id="clearHistory" class="secondary">Clear History</button>
        </div>
      </div>
      <hr />
      <div>
        <label for="savedFilters">Saved Filters</label>
        <div class="saved-filters" id="savedFilters">
        </div>
        <div class="save-filter-form">
          <div class="save-filter-row">
            <input id="saveFilterName" class="save-filter-input" type="text" placeholder="Filter name" />
            <button id="saveFilter" class="secondary">Save</button>
          </div>
          <input id="saveFilterDescription" class="save-filter-input" type="text" placeholder="Description (optional)" />
        </div>
      </div>
      <hr />
      <div>
        <label for="name">Name filter</label>
        <input id="name" type="text" placeholder="e.g. DIAG" />
      </div>
    <div class="row">
      <div>
        <label for="mode">Mode</label>
        <select id="mode">
          <option value="contains">Contains</option>
          <option value="regex">Regex</option>
          <option value="glob">Glob</option>
        </select>
      </div>
      <div>
        <label>&nbsp;</label>
        <button id="toggle">Advanced...</button>
      </div>
    </div>
    <div class="advanced" id="advanced">
      <div>
        <label for="arpath">ARPATH filter</label>
        <input id="arpath" type="text" placeholder="e.g. /AUTOSAR/ECUC" />
      </div>
      <div>
        <label for="element">Element tag filter</label>
        <input id="element" type="text" placeholder="e.g. ECUDOC" />
      </div>
    </div>
    <div class="actions">
      <button id="apply">Apply</button>
      <button id="clear" class="secondary">Clear</button>
    </div>
    <div id="filterStats" class="filter-stats"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    
    function showNotification(message, type) {
      const notification = document.getElementById('notifications');
      const messageElement = document.getElementById('notificationMessage');
      const spinner = document.getElementById('loadingSpinner');
      
      messageElement.textContent = message;
      notification.className = 'notification show ' + type;
      
      if (type === 'loading') {
        spinner.style.display = 'block';
      } else {
        spinner.style.display = 'none';
      }
      
      if (type !== 'loading') {
        setTimeout(() => {
          hideNotification();
        }, 5000);
      }
    }

    function hideNotification() {
      const notification = document.getElementById('notifications');
      notification.className = 'notification';
    }

    function validateInput(element, value) {
      if (element.id === 'saveFilterName' && value.length > 100) {
        element.classList.add('input-error');
        showNotification('Filter name is too long (maximum 100 characters)', 'warning');
        return false;
      }
      if (element.id === 'saveFilterDescription' && value.length > 500) {
        element.classList.add('input-error');
        showNotification('Description is too long (maximum 500 characters)', 'warning');
        return false;
      }
      element.classList.remove('input-error');
      return true;
    }
    
    const toggle = document.getElementById('toggle');
    const advanced = document.getElementById('advanced');
    toggle.addEventListener('click', () => {
      advanced.classList.toggle('show');
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'views') {
        const select = document.getElementById('customView');
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Default (no custom view)';
        select.appendChild(defaultOption);
        for (const view of message.payload) {
          const option = document.createElement('option');
          option.value = view.id;
          option.textContent = view.name;
          select.appendChild(option);
        }
      } else if (message?.type === 'searchHistory') {
        const historyContainer = document.getElementById('searchHistory');
        historyContainer.innerHTML = '';
        if (message.payload.length === 0) {
          historyContainer.innerHTML = '<div class="history-item"><span class="history-item-label">No search history</span></div>';
        } else {
          for (const item of message.payload) {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            historyItem.innerHTML = '<span class="history-item-label">' + item.label + '</span><button class="history-item-remove" data-id="' + item.id + '">×</button>';
            historyItem.addEventListener('click', (e) => {
              if (e.target.classList.contains('history-item-remove')) {
                e.stopPropagation();
                vscode.postMessage({ type: 'removeSearchHistory', payload: { id: e.target.dataset.id } });
              } else {
                vscode.postMessage({ type: 'applySearchHistory', payload: { id: item.id } });
              }
            });
            historyContainer.appendChild(historyItem);
          }
        }
      } else if (message?.type === 'setFilterValues') {
        const filter = message.payload;
        document.getElementById('mode').value = filter.mode || 'contains';
        document.getElementById('name').value = filter.name || '';
        document.getElementById('arpath').value = filter.arpath || '';
        document.getElementById('element').value = filter.element || '';
      } else if (message?.type === 'savedFilters') {
        const savedFiltersContainer = document.getElementById('savedFilters');
        savedFiltersContainer.innerHTML = '';
        if (message.payload.length === 0) {
          savedFiltersContainer.innerHTML = '<div class="saved-filter-item"><div class="saved-filter-main"><div class="saved-filter-name">No saved filters</div></div></div>';
        } else {
          for (const filter of message.payload) {
            const filterItem = document.createElement('div');
            filterItem.className = 'saved-filter-item';
            const description = filter.description ? '<div class="saved-filter-description">' + filter.description + '</div>' : '';
            filterItem.innerHTML = '<div class="saved-filter-main"><div class="saved-filter-name">' + filter.name + '</div>' + description + '</div><div class="saved-filter-actions"><button class="saved-filter-action" data-action="delete" data-id="' + filter.id + '">×</button></div>';
            
            filterItem.querySelector('.saved-filter-main').addEventListener('click', () => {
              vscode.postMessage({ type: 'applySavedFilter', payload: { id: filter.id } });
            });
            
            filterItem.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'deleteSavedFilter', payload: { id: filter.id } });
            });
            
            savedFiltersContainer.appendChild(filterItem);
          }
        }
      } else if (message?.type === 'getCurrentFilter') {
        const currentFilter = {
          mode: document.getElementById('mode').value,
          name: document.getElementById('name').value.trim() || undefined,
          arpath: document.getElementById('arpath').value.trim() || undefined,
          element: document.getElementById('element').value.trim() || undefined
        };
        vscode.postMessage({ type: 'currentFilter', payload: currentFilter });
      } else if (message?.type === 'filterStats') {
        const statsElement = document.getElementById('filterStats');
        const stats = message.payload;
        if (stats.resultCount >= 0) {
          statsElement.textContent = stats.resultCount === 1 ? '1 result found' : stats.resultCount + ' results found';
          statsElement.className = stats.hasResults ? 'filter-stats show' : 'filter-stats show no-results';
        } else {
          statsElement.className = 'filter-stats';
        }
      } else if (message?.type === 'validationError') {
        showNotification(message.payload.message, 'warning');
      } else if (message?.type === 'error') {
        showNotification(message.payload.message, 'error');
      } else if (message?.type === 'success') {
        showNotification(message.payload.message, 'success');
      } else if (message?.type === 'loading') {
        if (message.payload.loading) {
          showNotification(message.payload.message, 'loading');
        } else {
          hideNotification();
        }
      }
    });
    vscode.postMessage({ type: 'ready' });
    document.getElementById('customView').addEventListener('change', (event) => {
      const target = event.target;
      vscode.postMessage({ type: 'applyCustomView', payload: { id: target.value || undefined } });
    });
    document.getElementById('clearCustomView').addEventListener('click', () => {
      document.getElementById('customView').value = '';
      vscode.postMessage({ type: 'clearCustomView' });
    });
    document.getElementById('editCustomView').addEventListener('click', () => {
      vscode.postMessage({ type: 'editCustomViews' });
    });
    document.getElementById('exportAllViews').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportAllCustomViews' });
    });
    document.getElementById('exportSelectedViews').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportSelectedCustomViews' });
    });
    document.getElementById('importViews').addEventListener('click', () => {
      vscode.postMessage({ type: 'importCustomViews' });
    });
    document.getElementById('apply').addEventListener('click', () => {
      const payload = {
        mode: document.getElementById('mode').value,
        name: document.getElementById('name').value.trim() || undefined,
        arpath: document.getElementById('arpath').value.trim() || undefined,
        element: document.getElementById('element').value.trim() || undefined
      };
      vscode.postMessage({ type: 'apply', payload });
    });
    document.getElementById('clear').addEventListener('click', () => {
      document.getElementById('name').value = '';
      document.getElementById('arpath').value = '';
      document.getElementById('element').value = '';
      document.getElementById('filterStats').className = 'filter-stats';
      vscode.postMessage({ type: 'clear' });
    });
    document.getElementById('clearHistory').addEventListener('click', () => {
      vscode.postMessage({ type: 'clearSearchHistory' });
    });
    document.getElementById('saveFilter').addEventListener('click', () => {
      const name = document.getElementById('saveFilterName').value.trim();
      const description = document.getElementById('saveFilterDescription').value.trim();
      if (name) {
        vscode.postMessage({ type: 'saveFilter', payload: { name, description: description || undefined } });
        document.getElementById('saveFilterName').value = '';
        document.getElementById('saveFilterDescription').value = '';
      }
     });

    document.getElementById('notificationClose').addEventListener('click', hideNotification);

    document.getElementById('saveFilterName').addEventListener('input', (e) => {
      validateInput(e.target, e.target.value);
    });

    document.getElementById('saveFilterDescription').addEventListener('input', (e) => {
      validateInput(e.target, e.target.value);
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('apply').click();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Backspace') {
        e.preventDefault();
        document.getElementById('clear').click();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const nameInput = document.getElementById('saveFilterName');
        const name = nameInput.value.trim();
        if (name) {
          document.getElementById('saveFilter').click();
        } else {
          nameInput.focus();
        }
      }
      if (e.key === 'Enter' && e.target.id === 'saveFilterName') {
        e.preventDefault();
        document.getElementById('saveFilter').click();
      }
    });
  </script>
</body>
</html>`;
  }
}
