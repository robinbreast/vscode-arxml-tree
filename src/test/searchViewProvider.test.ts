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
  let postedMessages: any[];

  setup(() => {
    mockTreeProvider = {
      setFilterForDocument: async (document: vscode.TextDocument, config?: TreeFilterConfig) => {
        mockTreeProvider.lastFilterDocument = document;
        mockTreeProvider.lastFilterConfig = config;
      },
      getFilterResultCount: async (_config: TreeFilterConfig) => 0,
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
      addSearch: async (_filter: TreeFilterConfig) => {},
      getHistory: async () => [],
      removeItem: async (_id: string) => {},
      clearHistory: async () => {}
    };

    mockSavedFiltersStore = {
      saveFilter: async (name: string, filter: TreeFilterConfig, _description?: string) => ({ id: 'test', name, filter, createdAt: Date.now() }),
      getSavedFilters: async () => [],
      getFilterById: async (_id: string) => undefined,
      deleteFilter: async (_id: string) => {},
      updateLastUsed: async (_id: string) => {},
      renameFilter: async (_id: string, _newName: string) => {},
      updateDescription: async (_id: string, _description?: string) => {}
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
          postedMessages.push(message);
          mockWebviewView.webview.lastPostedMessage = message;
          return Promise.resolve(true);
        }
      }
    };

    postedMessages = [];
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
    
    const restoreActiveTextEditor = stubActiveTextEditor(mockEditor as vscode.TextEditor);

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

    restoreActiveTextEditor();
  });

  test('apply filter ignores non-ARXML document', async () => {
    const mockDocument = {
      uri: vscode.Uri.parse('file:///test.txt'),
      languageId: 'txt',
      fileName: 'test.txt'
    };
    const mockEditor = {
      document: mockDocument
    };
    
    const restoreActiveTextEditor = stubActiveTextEditor(mockEditor as vscode.TextEditor);

    searchProvider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'apply',
      payload: { mode: 'contains' }
    });

    assert.strictEqual(mockTreeProvider.lastFilterDocument, undefined);

    restoreActiveTextEditor();
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
    
    const restoreActiveTextEditor = stubActiveTextEditor(mockEditor as vscode.TextEditor);

    searchProvider.resolveWebviewView(mockWebviewView);

    await mockWebviewView.webview.onDidReceiveMessageHandler!({
      type: 'clear'
    });

    assert.strictEqual(mockTreeProvider.lastFilterDocument, mockDocument);
    assert.strictEqual(mockTreeProvider.lastFilterConfig, undefined);

    restoreActiveTextEditor();
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

    const viewsMessage = postedMessages.find((message) => message.type === 'views');
    assert.ok(viewsMessage);
    assert.deepStrictEqual(viewsMessage.payload, [
      { id: 'view1', name: 'View 1' },
      { id: 'view2', name: 'View 2' }
    ]);
    assert.ok(postedMessages.some((message) => message.type === 'searchHistory'));
    assert.ok(postedMessages.some((message) => message.type === 'savedFilters'));
  });

  test('refreshViews posts custom views to webview', async () => {
    const mockViews = [
      { id: 'refresh-view', name: 'Refresh View', config: {} }
    ];
    mockCustomViewStore.setMockViews(mockViews);

    searchProvider.resolveWebviewView(mockWebviewView);

    await searchProvider.refreshViews();

    const viewsMessage = postedMessages.find((message) => message.type === 'views');
    assert.ok(viewsMessage);
    assert.deepStrictEqual(viewsMessage.payload, [
      { id: 'refresh-view', name: 'Refresh View' }
    ]);
    assert.ok(postedMessages.some((message) => message.type === 'savedFilters'));
    assert.ok(postedMessages.some((message) => message.type === 'searchHistory'));
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

function stubActiveTextEditor(editor: vscode.TextEditor | undefined): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(vscode.window, 'activeTextEditor');
  Object.defineProperty(vscode.window, 'activeTextEditor', {
    configurable: true,
    get: () => editor
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(vscode.window, 'activeTextEditor', descriptor);
    } else {
      delete (vscode.window as Partial<typeof vscode.window>).activeTextEditor;
    }
  };
}
