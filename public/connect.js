(function (root) {
  'use strict';

  var IO_OPTIONS = {
    transports: ['websocket', 'polling'],
    timeout: 20000,
    forceNew: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    autoConnect: true
  };

  function ioOptions() {
    return IO_OPTIONS;
  }

  function getOrCreatePlayerId() {
    try {
      var pid = localStorage.getItem('player.id');
      if (!pid) {
        pid = 'p_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
        localStorage.setItem('player.id', pid);
      }
      return pid;
    } catch (_) {
      return 'p_' + Math.random().toString(36).slice(2);
    }
  }

  function getOrCreateDisplayId() {
    try {
      var id = sessionStorage.getItem('display.id');
      if (!id) {
        id = 'd_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
        sessionStorage.setItem('display.id', id);
      }
      return id;
    } catch (_) {
      return 'd_' + Math.random().toString(36).slice(2);
    }
  }

  function onResume(socket, identify) {
    if (!socket || typeof identify !== 'function') return;
    function run() {
      try { identify(); } catch (_) {}
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    window.addEventListener('online', function () {
      if (socket.connected) run();
      else if (typeof socket.connect === 'function') socket.connect();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && socket.connected) run();
    });
  }

  root.MEGASheepConnect = {
    ioOptions: ioOptions,
    getOrCreatePlayerId: getOrCreatePlayerId,
    getOrCreateDisplayId: getOrCreateDisplayId,
    onResume: onResume
  };
})(typeof window !== 'undefined' ? window : globalThis);
