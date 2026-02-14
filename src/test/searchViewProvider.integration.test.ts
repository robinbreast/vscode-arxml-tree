import * as assert from 'assert';
import * as vscode from 'vscode';
import { SearchViewProvider } from '../searchViewProvider';
import { TreeFilterConfig } from '../treeProvider';

suite('SearchViewProvider Integration Tests', () => {
  let mockTreeProvider: any;
  let mockCustomViewStore: any;
  let mockSearchHistoryStore: any;
  let mockSavedFiltersStore: any;
  let searchProvider: SearchViewProvider;
  let webviewPanel: vscode.WebviewPanel | undefined;
  let postedMessages: any[];

  setup(() => {
    postedMessages = [];

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
      list: async () => [
        { id: 'test-view', name: 'Test View', config: {} }
      ]
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

    let appliedViewId: string | undefined;
    let viewCleared = false;

    const applyCallback = async (id?: string) => {
      appliedViewId = id;
    };

    const clearCallback = async () => {
      viewCleared = true;
      appliedViewId = undefined;
    };

    searchProvider = new SearchViewProvider(
      mockTreeProvider,
      mockCustomViewStore,
      mockSearchHistoryStore,
      mockSavedFiltersStore,
      applyCallback,
      clearCallback
    );
  });

  teardown(() => {
    webviewPanel?.dispose();
  });

  test('webview receives initial custom views on ready message', async () => {
    const webview = createMockWebview(postedMessages);
    const webviewView = createMockWebviewView(webview);
    
    searchProvider.resolveWebviewView(webviewView);

    await webview.simulateMessage({ type: 'ready' });

    const viewsMessage = postedMessages.find((message) => message.type === 'views');
    assert.ok(viewsMessage);
    assert.deepStrictEqual(viewsMessage.payload, [
      { id: 'test-view', name: 'Test View' }
    ]);
    assert.ok(postedMessages.some((message) => message.type === 'searchHistory'));
    assert.ok(postedMessages.some((message) => message.type === 'savedFilters'));
  });

  test('filter application message flow', async () => {
    const webview = createMockWebview(postedMessages);
    const webviewView = createMockWebviewView(webview);
    
    const mockDocument = {
      uri: vscode.Uri.parse('file:///test.arxml'),
      languageId: 'arxml'
    } as vscode.TextDocument;

    const restoreActiveTextEditor = stubActiveTextEditor({ document: mockDocument } as vscode.TextEditor);

    searchProvider.resolveWebviewView(webviewView);

    const filterConfig = {
      mode: 'regex' as const,
      name: 'Integration.*Test',
      arpath: '/Integration/Test'
    };

    await webview.simulateMessage({
      type: 'apply',
      payload: filterConfig
    });

    assert.strictEqual(mockTreeProvider.lastFilterDocument, mockDocument);
    assert.deepStrictEqual(mockTreeProvider.lastFilterConfig, filterConfig);

    restoreActiveTextEditor();
  });

  test('custom view selection message flow', async () => {
    const webview = createMockWebview(postedMessages);
    const webviewView = createMockWebviewView(webview);
    
    let appliedCustomViewId: string | undefined;
    
    const provider = new SearchViewProvider(
      mockTreeProvider,
      mockCustomViewStore,
      mockSearchHistoryStore,
      mockSavedFiltersStore,
      async (id?: string) => {
        appliedCustomViewId = id;
      },
      async () => {}
    );

    provider.resolveWebviewView(webviewView);

    await webview.simulateMessage({
      type: 'applyCustomView',
      payload: { id: 'integration-test-view' }
    });

    assert.strictEqual(appliedCustomViewId, 'integration-test-view');
  });

  test('clear operations message flow', async () => {
    const webview = createMockWebview(postedMessages);
    const webviewView = createMockWebviewView(webview);
    
    const mockDocument = {
      uri: vscode.Uri.parse('file:///clear-test.arxml'),
      languageId: 'arxml'
    } as vscode.TextDocument;

    const restoreActiveTextEditor = stubActiveTextEditor({ document: mockDocument } as vscode.TextEditor);

    let customViewCleared = false;
    
    const provider = new SearchViewProvider(
      mockTreeProvider,
      mockCustomViewStore,
      mockSearchHistoryStore,
      mockSavedFiltersStore,
      async () => {},
      async () => {
        customViewCleared = true;
      }
    );

    provider.resolveWebviewView(webviewView);

    await webview.simulateMessage({ type: 'clear' });
    assert.strictEqual(mockTreeProvider.lastFilterDocument, mockDocument);
    assert.strictEqual(mockTreeProvider.lastFilterConfig, undefined);

    await webview.simulateMessage({ type: 'clearCustomView' });
    assert.strictEqual(customViewCleared, true);

    restoreActiveTextEditor();
  });

  test('apply ignores invalid documents', async () => {
    const webview = createMockWebview(postedMessages);
    const webviewView = createMockWebviewView(webview);

    const mockNonArxmlDocument = {
      uri: vscode.Uri.parse('file:///test.txt'),
      languageId: 'txt'
    } as vscode.TextDocument;

    const restoreActiveTextEditor = stubActiveTextEditor({ document: mockNonArxmlDocument } as vscode.TextEditor);

    searchProvider.resolveWebviewView(webviewView);

    await webview.simulateMessage({
      type: 'apply',
      payload: { mode: 'contains', name: 'test' }
    });

    assert.strictEqual(mockTreeProvider.lastFilterDocument, undefined);

    restoreActiveTextEditor();
  });

  test('webview view refresh updates displayed views', async () => {
    const webview = createMockWebview(postedMessages);
    const webviewView = createMockWebviewView(webview);

    searchProvider.resolveWebviewView(webviewView);

    mockCustomViewStore.list = async () => [
      { id: 'new-view', name: 'New View', config: {} },
      { id: 'another-view', name: 'Another View', config: {} }
    ];

    await searchProvider.refreshViews();

    const viewsMessage = postedMessages.find((message) => message.type === 'views');
    assert.ok(viewsMessage);
    assert.deepStrictEqual(viewsMessage.payload, [
      { id: 'new-view', name: 'New View' },
      { id: 'another-view', name: 'Another View' }
    ]);
    assert.ok(postedMessages.some((message) => message.type === 'savedFilters'));
    assert.ok(postedMessages.some((message) => message.type === 'searchHistory'));
  });
});

function createMockWebview(postedMessages: any[]) {
  const messageHandlers: Array<(message: any) => void> = [];
  
  return {
    options: undefined,
    html: '',
    onDidReceiveMessage: (handler: (message: any) => void) => {
      messageHandlers.push(handler);
      return { dispose: () => {} };
    },
    postMessage: (message: any) => {
      postedMessages.push(message);
      return Promise.resolve(true);
    },
    simulateMessage: async (message: any) => {
      for (const handler of messageHandlers) {
        await handler(message);
      }
    }
  };
}

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

function createMockWebviewView(webview: any) {
  return {
    webview,
    viewType: 'arxml-search-view',
    visible: true,
    onDidDispose: new vscode.EventEmitter<void>().event,
    onDidChangeVisibility: new vscode.EventEmitter<void>().event,
    show: () => {}
  } as vscode.WebviewView;
}
