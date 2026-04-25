// =====================================================================
// balanceOps.js — primitive unifiee pour les operations sur le solde
// =====================================================================
// Toute mutation ou lecture du solde central passe par ce module : achat
// lunch, debit reservation, transfert parent->dependant, refund. Quand
// la centrale ne repond pas, l'op est persistee dans une outbox local-
// Storage et rejouee automatiquement (intervalle 30 s + evenement
// 'online' + au boot). L'idempotency_key cote serveur (whitelist deja
// en place dans finance-bridge) garantit qu'aucun retry ne provoque
// un double debit.
//
// Usage :
//   const ops = createBalanceOps({
//     bridgeUrl: 'https://<central>/functions/v1/finance-bridge',
//     anonKey:   'sb_publishable_...',
//     getAuthToken: async () => sessionToken,    // null si pas de session
//     storageKey:   'modulimo:balanceOps:outbox:v1',
//     onChange:     (count, hasStuck) => updateBanner(count, hasStuck),
//   });
//
//   const r = await ops.commit({
//     type: 'space_reservation',
//     amount: -12.50,
//     idempotency_key: 'space-resv:' + reservation_id,
//     reference_id: reservation_id,
//     reference_type: 'space_reservation',
//     description: 'Salle commune 2026-04-25',
//   });
//
// Le retour est l'un des trois cas :
//   { ok:true,  transaction_id, virtual_balance, idempotent_replay? }
//   { ok:false, queued:true, queueId }            (rejouee plus tard)
//   { ok:false, error, status, retryable:false }  (erreur metier definitive)
//
// L'appelant DOIT gerer queued=true differemment d'un succes (l'action
// locale n'est pas encore confirmee par central, mais sera retentee).
// Pour les flows ou un succes optimiste est acceptable (ex: livraison
// lunch deja effectuee), traiter queued comme succes. Pour les autres
// (ex: reservation espace), refuser l'action et demander de retenter.
//
// IMPORTANT : l'idempotency_key DOIT etre stable pour la meme intention
// d'action (ex: 'space-resv:' + reservation_uuid), pas un UUID aleatoire
// genere a chaque tentative. Sinon les retries de l'outbox creent des
// doublons. Toutes les routes finance-bridge l'exigent deja.
// =====================================================================

(function (global) {
  'use strict';

  function createBalanceOps(config) {
    if (!config || !config.bridgeUrl || !config.anonKey || !config.getAuthToken) {
      throw new Error('createBalanceOps: bridgeUrl, anonKey et getAuthToken sont requis');
    }

    var bridgeUrl     = config.bridgeUrl.replace(/\/$/, '');
    var anonKey       = config.anonKey;
    var getAuthToken  = config.getAuthToken;
    var storageKey    = config.storageKey   || 'modulimo:balanceOps:outbox:v1';
    var onChange      = config.onChange     || function () {};
    var maxAttempts   = config.maxAttempts  || 50;     // ~24h avec backoff
    var maxOutboxSize = config.maxOutboxSize|| 50;
    var fetchTimeout  = config.fetchTimeout || 8000;
    var replayMs      = config.replayMs     || 30000;
    var backoffMs     = config.backoffMs    || function (n) {
      // 5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s, capped at 1h.
      return Math.min(3600000, 5000 * Math.pow(2, Math.max(0, n - 1)));
    };

    // ─── Outbox storage ────────────────────────────────────────────────
    function loadOutbox() {
      try {
        var raw = global.localStorage && global.localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.warn('[balanceOps] loadOutbox parse error:', e && e.message);
        return [];
      }
    }
    function saveOutbox(list) {
      try {
        if (global.localStorage) {
          global.localStorage.setItem(storageKey, JSON.stringify(list));
        }
      } catch (e) {
        console.warn('[balanceOps] saveOutbox failed:', e && e.message);
      }
      try {
        var stuckCount = 0;
        for (var i = 0; i < list.length; i++) if (list[i].stuck) stuckCount++;
        onChange(list.length, stuckCount > 0);
      } catch (e) { console.warn('[balanceOps] onChange threw:', e && e.message); }
    }
    function enqueue(entry) {
      var list = loadOutbox();
      // Dedup : si une op avec la meme idempotency_key ET le meme endpoint
      // existe deja, on ne la rajoute pas (le serveur reconnaitra le replay
      // de toute facon, mais ca evite d'enfler l'outbox sur des retries
      // utilisateur successifs).
      for (var i = 0; i < list.length; i++) {
        if (list[i].endpoint === entry.endpoint
            && list[i].body && entry.body
            && list[i].body.idempotency_key === entry.body.idempotency_key) {
          return list[i].queueId;
        }
      }
      if (list.length >= maxOutboxSize) {
        var err = new Error('OUTBOX_FULL');
        err.code = 'OUTBOX_FULL';
        throw err;
      }
      list.push(entry);
      saveOutbox(list);
      return entry.queueId;
    }
    function removeFromOutbox(queueId) {
      var list = loadOutbox();
      var next = [];
      for (var i = 0; i < list.length; i++) if (list[i].queueId !== queueId) next.push(list[i]);
      saveOutbox(next);
    }
    function patchInOutbox(queueId, patch) {
      var list = loadOutbox();
      for (var i = 0; i < list.length; i++) {
        if (list[i].queueId === queueId) {
          for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
          break;
        }
      }
      saveOutbox(list);
    }

    // ─── HTTP layer ────────────────────────────────────────────────────
    function classifyStatus(status) {
      // 0 = network/timeout. 408 timeout. 429 rate-limit. 5xx serveur.
      if (status === 0)   return 'retryable';
      if (status === 408) return 'retryable';
      if (status === 429) return 'retryable';
      if (status >= 500 && status < 600) return 'retryable';
      // 401 = JWT invalide ou expire : on NE retry PAS automatiquement (le
      // token figé dans l'outbox ne deviendra pas magiquement valide), on
      // marque l'op stuck pour intervention manuelle.
      return 'hard';
    }

    async function callBridgeOnce(endpoint, body, token) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, fetchTimeout);
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      try {
        var headers = {
          'Content-Type': 'application/json',
          'apikey': anonKey,
        };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        var res = await fetch(bridgeUrl + '/' + endpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        var data = null;
        try { data = await res.json(); } catch (_) {}
        var elapsed = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
        return { ok: res.ok, status: res.status, data: data, latency_ms: elapsed };
      } catch (err) {
        var elapsed2 = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0);
        return { ok: false, status: 0, data: null, latency_ms: elapsed2, network_error: (err && err.message) || 'network' };
      } finally {
        clearTimeout(t);
      }
    }

    function normalizeResult(httpRes) {
      if (httpRes.ok) {
        var d = httpRes.data || {};
        return {
          ok: true,
          transaction_id:     d.transaction_id     || d.parent_transaction_id || null,
          virtual_balance:    (typeof d.virtual_balance === 'number') ? d.virtual_balance
                              : (typeof d.parent_balance_after === 'number' ? d.parent_balance_after : null),
          dep_balance_after:  (typeof d.dep_balance_after === 'number') ? d.dep_balance_after : null,
          dep_transaction_id: d.dep_transaction_id || null,
          idempotent_replay:  !!d.idempotent_replay,
          raw: d,
        };
      }
      var error = (httpRes.data && httpRes.data.error) || (httpRes.network_error ? 'NETWORK' : ('HTTP_' + httpRes.status));
      var kind  = classifyStatus(httpRes.status);
      return {
        ok: false,
        error: error,
        status: httpRes.status,
        retryable: kind === 'retryable',
        body: httpRes.data,
      };
    }

    // ─── Submit (immediate or queue) ───────────────────────────────────
    async function submit(endpoint, body) {
      if (!body || !body.idempotency_key) {
        return { ok: false, error: 'MISSING_IDEMPOTENCY_KEY', status: 400, retryable: false };
      }
      var token;
      try { token = await getAuthToken(); } catch (e) { token = null; }
      if (!token) {
        return { ok: false, error: 'NO_SESSION', status: 401, retryable: false };
      }

      var http = await callBridgeOnce(endpoint, body, token);
      var result = normalizeResult(http);
      if (result.ok || !result.retryable) return result;

      // Retryable : queue + retry en arriere-plan.
      var queueId = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : ('q' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
      var entry = {
        queueId:       queueId,
        endpoint:      endpoint,
        body:          body,
        token:         token,                 // fige au moment de la queue
        created_at:    Date.now(),
        attempts:      1,
        last_error:    result.error,
        last_status:   result.status,
        next_retry_at: Date.now() + backoffMs(1),
        stuck:         false,
      };
      try {
        enqueue(entry);
      } catch (e) {
        return { ok: false, error: 'OUTBOX_FULL', status: 0, retryable: false };
      }
      return { ok: false, queued: true, queueId: queueId };
    }

    // ─── Replay loop ───────────────────────────────────────────────────
    var _replayInflight = false;
    async function replay() {
      if (_replayInflight) return;
      _replayInflight = true;
      try {
        var list = loadOutbox();
        var now = Date.now();
        for (var i = 0; i < list.length; i++) {
          var entry = list[i];
          if (entry.stuck) continue;
          if (entry.next_retry_at > now) continue;
          var http = await callBridgeOnce(entry.endpoint, entry.body, entry.token);
          var r = normalizeResult(http);
          if (r.ok) {
            console.info('[balanceOps] replay OK', entry.endpoint, 'attempt=', entry.attempts);
            removeFromOutbox(entry.queueId);
            continue;
          }
          if (!r.retryable) {
            console.warn('[balanceOps] replay STUCK', entry.endpoint, r.error, r.status);
            patchInOutbox(entry.queueId, { stuck: true, last_error: r.error, last_status: r.status });
            continue;
          }
          var nextAttempts = entry.attempts + 1;
          if (nextAttempts >= maxAttempts) {
            console.error('[balanceOps] replay GAVE UP', entry.endpoint, 'after', nextAttempts, 'attempts');
            patchInOutbox(entry.queueId, { stuck: true, attempts: nextAttempts, last_error: 'MAX_ATTEMPTS' });
            continue;
          }
          patchInOutbox(entry.queueId, {
            attempts: nextAttempts,
            last_error: r.error,
            last_status: r.status,
            next_retry_at: Date.now() + backoffMs(nextAttempts),
          });
        }
      } finally {
        _replayInflight = false;
      }
    }

    // Demarre la boucle de replay.
    var _replayTimer = setInterval(replay, replayMs);
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('online', function () {
        // Au retour en ligne, force un replay immediat de toutes les ops
        // (en remettant next_retry_at a 0 pour les non-stuck).
        var list = loadOutbox();
        var now = Date.now();
        var changed = false;
        for (var i = 0; i < list.length; i++) {
          if (!list[i].stuck && list[i].next_retry_at > now) {
            list[i].next_retry_at = now;
            changed = true;
          }
        }
        if (changed) saveOutbox(list);
        replay();
      });
    }
    // Replay differé au boot pour reprendre les ops en attente de la
    // session precedente, sans bloquer le rendu initial.
    setTimeout(function () { replay(); }, 1500);
    // Notifier l'UI de l'etat initial.
    setTimeout(function () {
      var list = loadOutbox();
      var stuck = 0;
      for (var i = 0; i < list.length; i++) if (list[i].stuck) stuck++;
      try { onChange(list.length, stuck > 0); } catch (_) {}
    }, 0);

    // ─── API metier ────────────────────────────────────────────────────
    function commit(params) {
      // type doit etre dans la whitelist debit ou refund cote finance-bridge.
      // amount < 0 pour debit, amount > 0 pour refund.
      return submit('debit', params);
    }
    function refund(params) {
      // Sucre syntaxique : alias de commit avec verification que amount > 0.
      if (typeof params.amount !== 'number' || params.amount <= 0) {
        return Promise.resolve({ ok: false, error: 'INVALID_AMOUNT', status: 400, retryable: false });
      }
      return submit('debit', params);
    }
    function lunchPurchase(params) {
      // params.amount > 0 ; finance-bridge convertit en debit.
      return submit('lunch-purchase', params);
    }
    function transferToDep(params) {
      return submit('transfer-to-dep', params);
    }

    // ─── API observation / contrôle ────────────────────────────────────
    function getOutbox() { return loadOutbox(); }
    function retryNow()  { return replay(); }
    function clearStuck() {
      var list = loadOutbox();
      var next = [];
      for (var i = 0; i < list.length; i++) if (!list[i].stuck) next.push(list[i]);
      saveOutbox(next);
    }
    function clearAll() { saveOutbox([]); }

    return {
      commit: commit,
      refund: refund,
      lunchPurchase: lunchPurchase,
      transferToDep: transferToDep,
      getOutbox: getOutbox,
      retryNow: retryNow,
      clearStuck: clearStuck,
      clearAll: clearAll,
    };
  }

  global.createBalanceOps = createBalanceOps;
})(typeof window !== 'undefined' ? window : globalThis);
