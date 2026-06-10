/**
 * SaveManager — Système de sauvegarde centralisé
 * Gère les playtimes + save states pour tous les émulateurs.
 * Les saves sont stockées dans Firestore sous :
 *   users/{uid}/saves/{platform}_{gameName}
 *
 * Usage :
 *   await SaveManager.loadPlaytimes('gba')       → { 'Pokémon Émeraude': 45, ... }
 *   await SaveManager.addPlaytime('gba', 'Pokémon Émeraude', 12)
 *   await SaveManager.saveState('gba', 'Pokémon Émeraude', stateData)
 *   await SaveManager.loadState('gba', 'Pokémon Émeraude') → stateData | null
 *   await SaveManager.deleteSave('gba', 'Pokémon Émeraude')
 *   SaveManager.getSaveSlots('gba', 'Pokémon Émeraude') → [{ slot, date, label }]
 */

const SaveManager = {

  // ── Helpers internes ─────────────────────────────────────────────────────

  _isReady() {
    return !!(window.Auth?.currentUser && window.Firestore && window.FirebaseDB);
  },

  _uid() {
    return window.Auth?.currentUser?.uid || null;
  },

  _docRef(platform, gameName) {
    const key = `${platform}_${gameName.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
    return window.Firestore.doc(window.FirebaseDB, 'saves', `${this._uid()}_${key}`);
  },

  _userRef() {
    return window.Firestore.doc(window.FirebaseDB, 'users', this._uid());
  },

  // ── Playtimes ─────────────────────────────────────────────────────────────

  /**
   * Charge les playtimes d'une plateforme depuis Firestore.
   * @param {string} platform — 'gba' | 'ds' | 'nes' | 'n64'
   * @returns {Object} map { gameName: minutes }
   */
  async loadPlaytimes(platform) {
    if (!this._isReady()) return {};
    try {
      const snap = await window.Firestore.getDoc(this._userRef());
      if (snap.exists()) {
        return snap.data()[`${platform}_playtimes`] || {};
      }
    } catch (e) {
      console.warn('[SaveManager] loadPlaytimes failed:', e);
    }
    return {};
  },

  /**
   * Ajoute du temps de jeu pour un jeu et synchronise Firestore.
   * @param {string} platform
   * @param {string} gameName
   * @param {number} minutes — minutes à ajouter
   * @param {Object} currentMap — map playtime en cours (sera muté)
   */
  async addPlaytime(platform, gameName, minutes, currentMap) {
    if (!this._isReady()) return;
    const map = currentMap || {};
    map[gameName] = (map[gameName] || 0) + Math.max(1, minutes);
    try {
      await window.Firestore.setDoc(
        this._userRef(),
        { [`${platform}_playtimes`]: map },
        { merge: true }
      );
    } catch (e) {
      console.error('[SaveManager] addPlaytime failed:', e);
    }
  },

  // ── Save States ────────────────────────────────────────────────────────────

  /**
   * Sauvegarde un état de jeu dans Firestore.
   * @param {string} platform
   * @param {string} gameName
   * @param {string|Object} stateData — données de l'émulateur (base64 string ou objet)
   * @param {number} slot — numéro du slot (1-3, défaut 1)
   * @param {string} label — label optionnel affiché à l'utilisateur
   */
  async saveState(platform, gameName, stateData, slot = 1, label = '') {
    if (!this._isReady()) {
      console.warn('[SaveManager] Not ready — user not logged in or Firebase unavailable');
      return false;
    }
    try {
      const ref = this._docRef(platform, gameName);
      const now = new Date().toISOString();
      await window.Firestore.setDoc(ref, {
        platform,
        gameName,
        uid: this._uid(),
        updatedAt: now,
        [`slot_${slot}`]: {
          data: stateData,
          date: now,
          label: label || `Slot ${slot} — ${new Date().toLocaleString('fr-FR')}`,
        }
      }, { merge: true });
      console.log(`[SaveManager] Save OK — ${platform}/${gameName} slot ${slot}`);
      return true;
    } catch (e) {
      console.error('[SaveManager] saveState failed:', e);
      return false;
    }
  },

  /**
   * Charge un état de jeu depuis Firestore.
   * @param {string} platform
   * @param {string} gameName
   * @param {number} slot — slot à charger (défaut 1)
   * @returns {string|null} stateData ou null si inexistant
   */
  async loadState(platform, gameName, slot = 1) {
    if (!this._isReady()) return null;
    try {
      const snap = await window.Firestore.getDoc(this._docRef(platform, gameName));
      if (snap.exists()) {
        const slotData = snap.data()[`slot_${slot}`];
        return slotData?.data || null;
      }
    } catch (e) {
      console.error('[SaveManager] loadState failed:', e);
    }
    return null;
  },

  /**
   * Récupère les métadonnées des slots de sauvegarde (sans les données lourdes).
   * @param {string} platform
   * @param {string} gameName
   * @returns {Array} [{ slot, date, label, hasData }]
   */
  async getSlotsMeta(platform, gameName) {
    if (!this._isReady()) return [];
    try {
      const snap = await window.Firestore.getDoc(this._docRef(platform, gameName));
      if (!snap.exists()) return [];
      const data = snap.data();
      return [1, 2, 3].map(slot => {
        const s = data[`slot_${slot}`];
        return {
          slot,
          hasData: !!s,
          date: s?.date || null,
          label: s?.label || `Slot ${slot} — vide`,
        };
      });
    } catch (e) {
      console.error('[SaveManager] getSlotsMeta failed:', e);
      return [];
    }
  },

  /**
   * Supprime tous les saves d'un jeu.
   */
  async deleteSave(platform, gameName) {
    if (!this._isReady()) return;
    try {
      await window.Firestore.deleteDoc(this._docRef(platform, gameName));
    } catch (e) {
      console.error('[SaveManager] deleteSave failed:', e);
    }
  },

  // ── UI Helper — barre de save dans l'émulateur ────────────────────────────

  /**
   * Injecte les boutons Save/Load dans la barre de l'émulateur.
   * À appeler après avoir injecté le HTML de l'émulateur dans le container.
   *
   * @param {HTMLElement} container — le container de l'émulateur
   * @param {string} platform
   * @param {string} gameName
   * @param {HTMLIFrameElement} iframe — l'iframe de l'émulateur
   */
  injectSaveUI(container, platform, gameName, iframe) {
    const toolbar = container.querySelector('.emu-toolbar');
    if (!toolbar) return;

    // Crée les boutons Save / Load
    const saveBtn = document.createElement('button');
    saveBtn.className = 'emu-save-btn';
    saveBtn.innerHTML = `💾 Sauvegarder`;
    saveBtn.style.cssText = `
      display:flex;align-items:center;gap:6px;background:rgba(0,180,100,0.2);
      border:2px solid rgba(0,220,120,0.4);border-radius:40px;padding:6px 16px;
      color:#7eff9a;font-weight:700;font-size:14px;cursor:pointer;transition:0.2s;
    `;
    saveBtn.onmouseover = () => saveBtn.style.background = 'rgba(0,180,100,0.4)';
    saveBtn.onmouseout  = () => saveBtn.style.background = 'rgba(0,180,100,0.2)';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'emu-load-btn';
    loadBtn.innerHTML = `📂 Charger`;
    loadBtn.style.cssText = `
      display:flex;align-items:center;gap:6px;background:rgba(0,120,255,0.2);
      border:2px solid rgba(0,160,255,0.4);border-radius:40px;padding:6px 16px;
      color:#7ec4ff;font-weight:700;font-size:14px;cursor:pointer;transition:0.2s;
    `;
    loadBtn.onmouseover = () => loadBtn.style.background = 'rgba(0,120,255,0.4)';
    loadBtn.onmouseout  = () => loadBtn.style.background = 'rgba(0,120,255,0.2)';

    toolbar.appendChild(saveBtn);
    toolbar.appendChild(loadBtn);

    // Feedback toast
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,0.85);color:#fff;padding:10px 22px;border-radius:30px;
      font-size:14px;font-weight:600;pointer-events:none;opacity:0;
      transition:opacity 0.3s;z-index:9999;
    `;
    container.style.position = 'relative';
    container.appendChild(toast);

    const showToast = (msg, color = '#7eff9a') => {
      toast.textContent = msg;
      toast.style.color = color;
      toast.style.opacity = '1';
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.style.opacity = '0', 2500);
    };

    // ── Save : envoie un message à l'iframe pour récupérer l'état ──
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Sauvegarde...';

      // On demande l'état à l'iframe via postMessage
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Fallback : sauvegarde un timestamp comme preuve de progression
          SaveManager.saveState(platform, gameName, { fallback: true, ts: Date.now() })
            .then(ok => {
              showToast(ok ? '✅ Sauvegardé (basique)' : '❌ Échec', ok ? '#7eff9a' : '#f88');
            });
          saveBtn.disabled = false;
          saveBtn.innerHTML = '💾 Sauvegarder';
        }
      }, 3000);

      const onMessage = async (e) => {
        if (e.data?.type !== 'SAVE_STATE_RESPONSE') return;
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);

        const ok = await SaveManager.saveState(platform, gameName, e.data.state);
        showToast(ok ? '✅ Partie sauvegardée !' : '❌ Échec de la sauvegarde', ok ? '#7eff9a' : '#f88');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '💾 Sauvegarder';
      };
      window.addEventListener('message', onMessage);

      // Demande l'état à l'iframe
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'GET_SAVE_STATE' }, '*');
      } else {
        // iframe pas encore dispo — force le fallback
        clearTimeout(timeout);
        const ok = await SaveManager.saveState(platform, gameName, { fallback: true, ts: Date.now() });
        showToast(ok ? '✅ Sauvegardé (basique)' : '❌ Échec', ok ? '#7eff9a' : '#f88');
        saveBtn.disabled = false;
        saveBtn.innerHTML = '💾 Sauvegarder';
      }
    });

    // ── Load : récupère l'état et l'envoie à l'iframe ──
    loadBtn.addEventListener('click', async () => {
      loadBtn.disabled = true;
      loadBtn.textContent = '⏳ Chargement...';

      const stateData = await SaveManager.loadState(platform, gameName);
      if (!stateData) {
        showToast('❌ Aucune sauvegarde trouvée', '#f88');
        loadBtn.disabled = false;
        loadBtn.innerHTML = '📂 Charger';
        return;
      }

      if (stateData.fallback) {
        showToast('ℹ️ Sauvegarde basique — relancez le jeu', '#ffd');
        loadBtn.disabled = false;
        loadBtn.innerHTML = '📂 Charger';
        return;
      }

      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'LOAD_SAVE_STATE', state: stateData }, '*');
        showToast('✅ Partie chargée !');
      } else {
        showToast('❌ Émulateur non prêt', '#f88');
      }

      loadBtn.disabled = false;
      loadBtn.innerHTML = '📂 Charger';
    });
  }
};

// Expose globalement
window.SaveManager = SaveManager;
export default SaveManager;
