import * as assert from 'assert';
import * as vscode from 'vscode';
import { SearchViewProvider } from '../searchViewProvider';
import { TreeFilterConfig } from '../treeProvider';

suite('SearchViewProvider', () => {
  let mockTreeProvider: any;
  let mockCustomViewStore: any;
  let mockSearchHistoryStore: any;
  let mockSavedFiltersStore: any;
  let mockWebviewView: any;
  let searchProvider: SearchViewProvider;
  let applyCustomViewCallback: (id?: string) => Promise<void>;
  let clearCustomViewCallback: () => Promise<void>;

  setup(() => {
    mockTreeProvider = {
      setFilterForDocument: async (document: vscode.TextDocument, config?: TreeFilterConfig) => {
        mockTreeProvider.lastFilterDocument = document;
        mockTreeProvider.lastFilterConfig = config;
      },
      lastFilterDocument: undefined,
      lastFilterConfig: undefined
    };

    mockCustomViewStore = {
      list: async () => mockCustomViewStore.mockViews || [],
      mockViews: [],
      setMockViews: (views: any[]) => {
        mockCustomViewStore.mockViews = views;
      }
    };

    mockSearchHistoryStore = {
      addSearch: async (filter: TreeFilterConfig) => {},
      getHistory: async () => [],
      removeItem: async (id: string) => {},
      clearHistory: async () => {}
    };

    mockSavedFiltersStore = {
      saveFilter: async (name: string, filter: TreeFilterConfig, description?: string) => ({ id: 'test', name, filter, createdAt: Date.now() }),
      getSavedFilters: async () => [],
      getFilterById: async (id: string) => undefined,
      deleteFilter: async (id: string) => {},
      updateLastUsed: async (id: string) => {},
      renameFilter: async (id: string, newName: string) => {},
      updateDescription: async (id: string, description?: string) => {}
    };
    
    let appliedCustomViewId: string | undefined;
    let customViewCleared = false;
    
    applyCustomViewCallback = async (id?: string) => {
      appliedCustomViewId = id;
    };
    
    clearCustomViewCallback = async () => {
      customViewCleared = true;
      appliedCustomViewId = undefined;
    };

    searchProvider = new SearchViewProvider(
      mockTreeProvider,
      mockCustomViewStore,
      mockSearchHistoryStore,
      mockSavedFiltersStore,
      applyCustomViewCallback,
      clearCustomViewCallback
    );

    mockWebviewView = {
      webview: {
        options: undefined,
        html: '',
        onDidReceiveMessageHandler: undefined,
        lastPostedMessage: undefined,
        onDidReceiveMessage: (handler: any) => {
          mockWebviewView.webview.onDidReceiveMessageHandler = handler;
          return { dispose: () => {} };
        },
        postMessage: (message: any) => {
          mockWebviewView.webview.lastPostedMessage = message;
          return Promise.resolve(true);
        }
      }
    };
  });

  test('constructor initializes with required dependencies', () => {
    assert.ok(searchProvider);
    assert.strictEqual(SearchViewProvider.viewType, 'arxml-search-view');
  });

  test('resolveWebviewView configures webview correctly', () => {
    searchProvider.resolveWebviewView(mockWebviewView);

    assert.strictEqual(mockWebviewView.webview.options?.enableScripts, true);
    assert.ok(mockWebviewView.webview.html.includes('DOCTYPE html'));
    assert.ok(mockWebviewView.webview.onDidReceiveMessageHandler);
  });

  test('apply filter message with valid ARXML document', async () => {
    const mockDocument = {
      uri: vscode.Uri.parse('file:///test.arxml'),
      languageId: 'arxml',
      fileName: 'test.arxml'
    };
    const mockEditor = {
      document: mockDocument
    };
    
    // Mock the active text editor
    const originalActiveTextEditor = vscode.window.activeTextEditor;
    (vscode.window as any).activeTextEditor = mockEditor;

    searchProvider.resolveWebviewView(mockWebviewView);

    const filterConfig: TreeFilterConfig = {
      mode: 'contains',
      name: 'TestFilter',
      arpath: '/Test/Path',
      element: 'TEST-ELEMENT'
    };

    // Simulate receiving apply message
    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'apply',
      payload: filterConfig
    });

    assert.strictEqual(mockTreeProvider.lastFilterDocument, mockDocument);
    assert.deepStrictEqual(mockTreeProvider.lastFilterConfig, filterConfig);

    // Restore original activeTextEditor
    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
  });

  test('apply filter shows info message for non-ARXML document', async () => {
    const mockDocument = {
      uri: vscode.Uri.parse('file:///test.txt'),
      languageId: 'txt',
      fileName: 'test.txt'
    };
    const mockEditor = {
      document: mockDocument
    };
    
    const originalActiveTextEditor = vscode.window.activeTextEditor;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    let infoMessageShown = false;
    
    (vscode.window as any).activeTextEditor = mockEditor;
    (vscode.window as any).showInformationMessage = (message: string) => {
      infoMessageShown = true;
      assert.strictEqual(message, 'Open an ARXML file to apply filters.');
      return Promise.resolve(undefined);
    };

    searchProvider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'apply',
      payload: { mode: 'contains' }
    });

    assert.strictEqual(infoMessageShown, true);
    assert.strictEqual(mockTreeProvider.lastFilterDocument, undefined);

    // Restore original methods
    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
    (vscode.window as any).showInformationMessage = originalShowInformationMessage;
  });

  test('clear filter message removes filter for ARXML document', async () => {
    const mockDocument = {
      uri: vscode.Uri.parse('file:///test.arxml'),
      languageId: 'arxml',
      fileName: 'test.arxml'
    };
    const mockEditor = {
      document: mockDocument
    };
    
    const originalActiveTextEditor = vscode.window.activeTextEditor;
    (vscode.window as any).activeTextEditor = mockEditor;

    searchProvider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'clear'
    });

    assert.strictEqual(mockTreeProvider.lastFilterDocument, mockDocument);
    assert.strictEqual(mockTreeProvider.lastFilterConfig, undefined);

    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
  });

  test('applyCustomView message calls callback with id', async () => {
    let appliedId: string | undefined;
    const callback = async (id?: string) => {
      appliedId = id;
    };

    const provider = new SearchViewProvider(
      mockTreeProvider,
      mockCustomViewStore,
      mockSearchHistoryStore,
      mockSavedFiltersStore,
      callback,
      clearCustomViewCallback
    );

    provider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'applyCustomView',
      payload: { id: 'test-view-id' }
    });

    assert.strictEqual(appliedId, 'test-view-id');
  });

  test('clearCustomView message calls callback', async () => {
    let cleared = false;
    const callback = async () => {
      cleared = true;
    };

    const provider = new SearchViewProvider(
      mockTreeProvider,
      mockCustomViewStore,
      mockSearchHistoryStore,
      mockSavedFiltersStore,
      applyCustomViewCallback,
      callback
    );

    provider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'clearCustomView'
    });

    assert.strictEqual(cleared, true);
  });

  test('ready message posts custom views', async () => {
    const mockViews = [
      { id: 'view1', name: 'View 1', config: {} },
      { id: 'view2', name: 'View 2', config: {} }
    ];
    mockCustomViewStore.setMockViews(mockViews);

    searchProvider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'ready'
    });

    assert.strictEqual(mockWebviewView.webview.lastPostedMessage?.type, 'views');
    assert.deepStrictEqual(mockWebviewView.webview.lastPostedMessage?.payload, [
      { id: 'view1', name: 'View 1' },
      { id: 'view2', name: 'View 2' }
    ]);
  });

  test('refreshViews posts custom views to webview', async () => {
    const mockViews = [
      { id: 'refresh-view', name: 'Refresh View', config: {} }
    ];
    mockCustomViewStore.setMockViews(mockViews);

    searchProvider.resolveWebviewView(mockWebviewView);

    await searchProvider.refreshViews();

    assert.strictEqual(mockWebviewView.webview.lastPostedMessage?.type, 'views');
    assert.deepStrictEqual(mockWebviewView.webview.lastPostedMessage?.payload, [
      { id: 'refresh-view', name: 'Refresh View' }
    ]);
  });

  test('getHtml returns valid HTML with required elements', () => {
    searchProvider.resolveWebviewView(mockWebviewView);
    
    const html = mockWebviewView.webview.html;
    
    // Check for required HTML structure
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html lang="en">'));
    assert.ok(html.includes('id="customView"'));
    assert.ok(html.includes('id="name"'));
    assert.ok(html.includes('id="mode"'));
    assert.ok(html.includes('id="arpath"'));
    assert.ok(html.includes('id="element"'));
    assert.ok(html.includes('id="apply"'));
    assert.ok(html.includes('id="clear"'));
    assert.ok(html.includes('id="toggle"'));
    
    // Check for JavaScript functionality
    assert.ok(html.includes('acquireVsCodeApi()'));
    assert.ok(html.includes('addEventListener'));
    assert.ok(html.includes('postMessage'));
  });
});