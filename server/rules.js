// Server-side write rules. The page still decides what to show, but the server now
// refuses writes the page's own access model would never allow — so the workspace
// and export lists can't be bypassed from the browser console.
'use strict';

const COLLECTIONS = new Set([
  'items', 'suppliers', 'pr_headers', 'pr_lines', 'po_log',
  'quote_comparisons', 'contracts', 'sample_requests', 'settings'
]);

// Collections only the Procurement Workspace writes to.
const WORKSPACE_ONLY = new Set(['items', 'suppliers', 'po_log', 'quote_comparisons', 'contracts']);

// Collections any signed-in requester writes to (PR submission, approvals, sample requests).
const REQUESTER = new Set(['pr_headers', 'pr_lines', 'sample_requests']);

const ACCESS_DOCS = {
  procurement_access: 'procurement_access',
  export_authorization: 'export_authorization'
};

function membersOf(store, docId) {
  const d = store.get('settings', docId);
  return (d && d.members) || {};
}

function isProcMember(store, user) {
  return !!user && (user.is_admin === 1 || !!membersOf(store, 'procurement_access')[user.id]);
}

function isExportAuthorized(store, user) {
  return !!user && (user.is_admin === 1 || !!membersOf(store, 'export_authorization')[user.id]);
}

function onlyKey(obj, key) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).length === 1 && Object.prototype.hasOwnProperty.call(obj, key);
}

// op: 'add' | 'set' | 'update' | 'delete'. Returns null if allowed, or a reason string.
function checkWrite(store, user, op, collection, id, data) {
  if (!user) return 'Sign in first.';
  if (!COLLECTIONS.has(collection)) return 'Unknown collection.';

  if (WORKSPACE_ONLY.has(collection)) {
    return isProcMember(store, user) ? null : 'Procurement Workspace access is required.';
  }

  if (REQUESTER.has(collection)) {
    if (op === 'delete' && !isProcMember(store, user)) return 'Only the Procurement team can delete records.';
    return null;
  }

  // settings/*
  if (ACCESS_DOCS[id]) {
    const allowed = id === 'procurement_access' ? isProcMember(store, user) : isExportAuthorized(store, user);
    if (allowed) return null;
    const members = membersOf(store, id);
    // Bootstrap: the very first member may add only themselves.
    if (Object.keys(members).length === 0 && op === 'set' && data &&
        onlyKey(data.members, user.id)) return null;
    // Anyone may ask to join: an update that only adds themselves to `pending`.
    if (op === 'update' && onlyKey(data, 'pending') && onlyKey(data.pending, user.id)) return null;
    return 'Only a current member can change this list.';
  }

  return isProcMember(store, user) ? null : 'Procurement Workspace access is required.';
}

module.exports = { COLLECTIONS, checkWrite, isProcMember, isExportAuthorized };
