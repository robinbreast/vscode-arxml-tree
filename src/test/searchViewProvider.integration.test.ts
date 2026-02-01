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
      list: async () => [
        { id: 'test-view', name: 'Test View', config: {} }
      ]
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
    const webview = createMockWebview();
    const webviewView = createMockWebviewView(webview);
    
    searchProvider.resolveWebviewView(webviewView);

    let receivedMessage: any;
    webview.postMessage = (message: any) => {
      receivedMessage = message;
      return Promise.resolve(true);
    };

    await webview.simulateMessage({ type: 'ready' });

    assert.strictEqual(receivedMessage?.type, 'views');
    assert.deepStrictEqual(receivedMessage?.payload, [
      { id: 'test-view', name: 'Test View' }
    ]);
  });

  test('filter application message flow', async () => {
    const webview = createMockWebview();
    const webviewView = createMockWebviewView(webview);
    
    const mockDocument = {
      uri: vscode.Uri.parse('file:///test.arxml'),
      languageId: 'arxml'
    } as vscode.TextDocument;

    const originalActiveTextEditor = vscode.window.activeTextEditor;
    (vscode.window as any).activeTextEditor = { document: mockDocument };

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

    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
  });

  test('custom view selection message flow', async () => {
    const webview = createMockWebview();
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
    const webview = createMockWebview();
    const webviewView = createMockWebviewView(webview);
    
    const mockDocument = {
      uri: vscode.Uri.parse('file:///clear-test.arxml'),
      languageId: 'arxml'
    } as vscode.TextDocument;

    const originalActiveTextEditor = vscode.window.activeTextEditor;
    (vscode.window as any).activeTextEditor = { document: mockDocument };

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

    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
  });

  test('error handling for invalid documents', async () => {
    const webview = createMockWebview();
    const webviewView = createMockWebviewView(webview);
    
    const mockNonArxmlDocument = {
      uri: vscode.Uri.parse('file:///test.txt'),
      languageId: 'txt'
    } as vscode.TextDocument;

    const originalActiveTextEditor = vscode.window.activeTextEditor;
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    
    let errorMessageShown = false;
    
    (vscode.window as any).activeTextEditor = { document: mockNonArxmlDocument };
    (vscode.window as any).showInformationMessage = (message: string) => {
      errorMessageShown = true;
      return Promise.resolve(undefined);
    };

    searchProvider.resolveWebviewView(webviewView);

    await webview.simulateMessage({
      type: 'apply',
      payload: { mode: 'contains', name: 'test' }
    });

    assert.strictEqual(errorMessageShown, true);
    assert.strictEqual(mockTreeProvider.lastFilterDocument, undefined);

    (vscode.window as any).activeTextEditor = originalActiveTextEditor;
    (vscode.window as any).showInformationMessage = originalShowInformationMessage;
  });

  test('webview view refresh updates displayed views', async () => {
    const webview = createMockWebview();
    const webviewView = createMockWebviewView(webview);
    
    searchProvider.resolveWebviewView(webviewView);

    mockCustomViewStore.list = async () => [
      { id: 'new-view', name: 'New View', config: {} },
      { id: 'another-view', name: 'Another View', config: {} }
    ];

    let lastMessage: any;
    webview.postMessage = (message: any) => {
      lastMessage = message;
      return Promise.resolve(true);
    };

    await searchProvider.refreshViews();

    assert.strictEqual(lastMessage?.type, 'views');
    assert.deepStrictEqual(lastMessage?.payload, [
      { id: 'new-view', name: 'New View' },
      { id: 'another-view', name: 'Another View' }
    ]);
  });
});

function createMockWebview() {
  const messageHandlers: Array<(message: any) => void> = [];
  
  return {
    options: undefined,
    html: '',
    onDidReceiveMessage: (handler: (message: any) => void) => {
      messageHandlers.push(handler);
      return { dispose: () => {} };
    },
    postMessage: (message: any) => Promise.resolve(true),
    simulateMessage: async (message: any) => {
      for (const handler of messageHandlers) {
        await handler(message);
      }
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