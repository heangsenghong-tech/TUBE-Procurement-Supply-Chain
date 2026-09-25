// Provides window.claude.use('db' | 'user' | 'downloads') for the Tube app page,
// backed by this server's REST API and live updates (Server-Sent Events) instead of
// the Claude artifact runtime. The page code itself is unchanged.
(function () {
  'use strict';

  function httpError(status, message) {
    var code = status === 401 ? 'unauthenticated' : status === 403 ? 'permission-denied' :
      status === 404 ? 'not-found' : status === 0 ? 'unavailable' : 'error';
    var e = new Error(message || code);
    e.code = code; e.status = status;
    return e;
  }

  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') opts.headers['X-Tube-Request'] = '1';
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) { window.location.href = '/login'; throw httpError(401, 'Signed out'); }
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw httpError(res.status, json && json.error);
        return json;
      });
    }, function () { throw httpError(0, 'Network unavailable'); });
  }

  // ---------------- live collection cache ----------------
  var cols = {};          // name -> { docs: Map, loaded: bool, loading: Promise, listeners: Set }
  var events = null;
  var hadError = false;

  function col(name) {
    if (!cols[name]) cols[name] = { docs: new Map(), loaded: false, loading: null, listeners: new Set() };
    return cols[name];
  }

  function load(name) {
    var c = col(name);
    c.loading = api('GET', '/api/db/' + encodeURIComponent(name)).then(function (json) {
      c.docs = new Map();
      json.docs.forEach(function (d) { c.docs.set(d.id, d.data); });
      c.loaded = true;
      notify(name);
    }).catch(function (e) {
      c.listeners.forEach(function (l) { if (l.onError) l.onError(e); });
      throw e;
    });
    return c.loading;
  }

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function notify(name) {
    var c = col(name);
    if (!c.loaded) return;
    c.listeners.forEach(function (l) {
      try { l.fire(c); } catch (e) { console.error(e); }
    });
  }

  function applyChange(name, op, id, data) {
    var c = col(name);
    if (!c.loaded) return;
    if (op === 'delete') c.docs.delete(id); else c.docs.set(id, data);
    notify(name);
  }

  function ensureEvents() {
    if (events) return;
    events = new EventSource('/api/events');
    events.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      applyChange(msg.collection, msg.op, msg.id, msg.data);
    };
    events.onerror = function () { hadError = true; };
    events.onopen = function () {
      // After a dropped connection, reload everything we're showing so nothing is missed.
      if (!hadError) return;
      hadError = false;
      Object.keys(cols).forEach(function (n) { if (cols[n].listeners.size) load(n).catch(function () {}); });
    };
  }

  function subscribe(name, fire, onError) {
    ensureEvents();
    var c = col(name);
    var l = { fire: fire, onError: onError };
    c.listeners.add(l);
    if (c.loaded) setTimeout(function () { if (c.listeners.has(l)) fire(c); }, 0);
    else if (!c.loading) load(name).catch(function () {});
    return function unsubscribe() { c.listeners.delete(l); };
  }

  function querySnapshot(c) {
    var docs = [];
    c.docs.forEach(function (data, id) {
      docs.push({ id: id, exists: true, data: function () { return clone(data); } });
    });
    return { docs: docs, size: docs.length, empty: docs.length === 0,
      forEach: function (fn) { docs.forEach(fn); } };
  }

  function docSnapshot(c, id) {
    var data = c.docs.get(id);
    return { id: id, exists: data !== undefined, data: function () { return clone(data); } };
  }

  function docRef(name, id) {
    var base = '/api/db/' + encodeURIComponent(name) + '/' + encodeURIComponent(id);
    return {
      id: id,
      get: function () {
        return api('GET', base).then(function (j) {
          return { id: id, exists: j.exists, data: function () { return clone(j.data); } };
        });
      },
      set: function (data) {
        return api('PUT', base, data).then(function (j) { applyChange(name, 'set', id, j.data); });
      },
      update: function (patch) {
        return api('PATCH', base, patch).then(function (j) { applyChange(name, 'set', id, j.data); });
      },
      delete: function () {
        return api('DELETE', base).then(function () { applyChange(name, 'delete', id); });
      },
      onSnapshot: function (cb, onError) {
        return subscribe(name, function (c) { cb(docSnapshot(c, id)); }, onError);
      }
    };
  }

  var dbApi = {
    collection: function (name) {
      return {
        doc: function (id) { return docRef(name, id); },
        add: function (data) {
          return api('POST', '/api/db/' + encodeURIComponent(name), data).then(function (j) {
            applyChange(name, 'set', j.id, j.data);
            return { id: j.id };
          });
        },
        get: function () {
          return api('GET', '/api/db/' + encodeURIComponent(name)).then(function (j) {
            var c = { docs: new Map() };
            j.docs.forEach(function (d) { c.docs.set(d.id, d.data); });
            return querySnapshot(c);
          });
        },
        onSnapshot: function (cb, onError) {
          return subscribe(name, function (c) { cb(querySnapshot(c)); }, onError);
        }
      };
    }
  };

  // ---------------- signed-in user ----------------
  function avatarFor(name) {
    var initials = String(name || '?').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52"><rect width="52" height="52" rx="26" fill="#FFCD00"/>' +
      '<text x="26" y="33" text-anchor="middle" font-family="Space Grotesk,Arial,sans-serif" font-size="20" font-weight="700" fill="#1C1E22">' +
      initials.replace(/[<>&"]/g, '') + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var mePromise = null;
  var userApi = {
    me: function () {
      if (!mePromise) {
        mePromise = api('GET', '/api/me').then(function (u) {
          window.tubeUser = u;
          return { id: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, avatarUrl: avatarFor(u.name) };
        });
      }
      return mePromise;
    },
    profiles: function (ids) {
      return api('GET', '/api/profiles?ids=' + encodeURIComponent(ids.join(',')));
    }
  };

  // ---------------- file downloads ----------------
  var downloadsApi = {
    save: function (opts) {
      var blob = opts.data instanceof Blob ? opts.data :
        new Blob([opts.data], { type: opts.mimeType || (/\.csv$/i.test(opts.filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream') });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = opts.filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      return Promise.resolve();
    }
  };

  function signOut() {
    return api('POST', '/api/logout').catch(function () {}).then(function () { window.location.href = '/login'; });
  }

  window.tubeSignOut = signOut;
  window.claude = {
    use: function (name) {
      if (name === 'db') return Promise.resolve(dbApi);
      if (name === 'user') return Promise.resolve(userApi);
      if (name === 'downloads') return Promise.resolve(downloadsApi);
      return Promise.reject(httpError(404, 'Unknown capability: ' + name));
    }
  };
})();
