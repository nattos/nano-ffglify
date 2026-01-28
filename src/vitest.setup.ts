import { vi } from 'vitest';


// Mock Web Audio API
class MockAudioContext {
  state = 'suspended';
  destination = {};
  createOscillator() { return { connect: () => { }, start: () => { }, stop: () => { }, disconnect: () => { }, frequency: { setValueAtTime: () => { } }, type: 'sine' }; }
  createGain() { return { connect: () => { }, disconnect: () => { }, gain: { setValueAtTime: () => { }, linearRampToValueAtTime: () => { }, exponentialRampToValueAtTime: () => { }, cancelScheduledValues: () => { }, setTargetAtTime: () => { } } }; }
  createBiquadFilter() { return { connect: () => { }, disconnect: () => { }, frequency: { setValueAtTime: () => { } }, type: 'lowpass' }; }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
}

(global as any).AudioContext = MockAudioContext;
(global as any).webkitAudioContext = MockAudioContext;

// Mock Worker
class MockWorker {
  onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;
  postMessage(message: any) {
    // Echo back if needed or just no-op
  }
  terminate() { }
  addEventListener() { }
  removeEventListener() { }
  dispatchEvent() { return true; }
}
(global as any).Worker = MockWorker;

// Mock IndexedDB
if (!globalThis.indexedDB) {
  const mockTransaction = {
    objectStore: vi.fn().mockReturnValue({
      put: vi.fn(),
      get: vi.fn().mockReturnValue({
        onsuccess: null,
        result: null,
        error: null,
      }),
    }),
    oncomplete: null,
    onerror: null,
  };

  const mockDb = {
    objectStoreNames: { contains: vi.fn().mockReturnValue(false) },
    createObjectStore: vi.fn(),
    transaction: vi.fn().mockReturnValue(mockTransaction),
  };

  const mockRequest = {
    onupgradeneeded: null,
    onsuccess: null,
    onerror: null,
    result: mockDb,
    error: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  // Simulate async success
  const openMock = vi.fn().mockImplementation(() => {
    setTimeout(() => {
      if (typeof mockRequest.onsuccess === 'function') {
        (mockRequest.onsuccess as Function)({ target: mockRequest });
      }
      // Also potentially check if addEventListener was called for 'success'
    }, 0);
    return mockRequest;
  });

  (globalThis as any).indexedDB = {
    open: openMock,
  };
  (globalThis as any).IDBRequest = class { };
  (globalThis as any).IDBTransaction = class { };
  (globalThis as any).IDBKeyRange = class { };
  (globalThis as any).IDBCursor = class { };
  (globalThis as any).IDBObjectStore = class { };
  (globalThis as any).IDBDatabase = class { };
  (globalThis as any).IDBFactory = class { };
  (globalThis as any).IDBOpenDBRequest = class { };
  (globalThis as any).IDBIndex = class { };
}

// Mock File System Access API
if (!(globalThis as any).showDirectoryPicker) {
  (globalThis as any).showDirectoryPicker = vi.fn();
}

// Mock document.queryCommandSupported and execCommand for Monaco
document.queryCommandSupported = document.queryCommandSupported || (() => false);

// Mock Web MIDI API
if (!navigator.requestMIDIAccess) {
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    value: vi.fn().mockResolvedValue({
      inputs: new Map(),
      outputs: new Map(),
      onstatechange: null,
    }),
    writable: true,
  });
}
