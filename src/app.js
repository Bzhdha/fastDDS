(function () {
  "use strict";

  /* ======================================================
     CONSTANTES
  ====================================================== */
  const EFS_BASE     = "https://oudonner.api.efs.sante.fr/carto-api/v3";
  const BAN_BASE     = "https://api-adresse.data.gouv.fr/search";
  const BAN_REVERSE  = "https://api-adresse.data.gouv.fr/reverse";
  const DEBOUNCE     = 280; // ms avant appel autocomplete

  /* ======================================================
     RATE LIMITER — protection contre les abus
  ====================================================== */
  const RateLimit = (() => {
    const MAX      = 8;      // appels max dans la fenêtre glissante
    const WINDOW   = 60_000; // fenêtre glissante : 60 secondes
    const COOLDOWN = 2_000;  // délai minimum entre deux appels consécutifs

    const stamps = [];
    let lastCall = 0;

    return {
      check() {
        const now = Date.now();

        const sinceLast = now - lastCall;
        if (lastCall && sinceLast < COOLDOWN) {
          const wait = Math.ceil((COOLDOWN - sinceLast) / 1000);
          return { ok: false, msg: `Patientez ${wait} seconde${wait > 1 ? "s" : ""} avant de relancer une recherche.` };
        }

        while (stamps.length && stamps[0] < now - WINDOW) stamps.shift();
        if (stamps.length >= MAX) {
          const wait = Math.ceil((stamps[0] + WINDOW - now) / 1000);
          return { ok: false, msg: `Trop de recherches en peu de temps. Réessayez dans ${wait} seconde${wait > 1 ? "s" : ""}.` };
        }

        stamps.push(now);
        lastCall = now;
        return { ok: true };
      }
    };
  })();

  /* ======================================================
     ÉTAT GLOBAL
  ====================================================== */
  let lat = null, lng = null, villeNom = null;
  let autocompleteTimer = null;
  let selectedIndex = -1;
  let suggestions = [];
  let efsController = null;

  /* ======================================================
     UTILITAIRES
  ====================================================== */
  const $ = id => document.getElementById(id);

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function plusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function formatDateFR(isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleDateString("fr-FR", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  }
  function formatHeure(t) {
    if (!t) return "";
    return t.slice(0, 5).replace(":", "h");
  }
  function kmStr(dist) {
    if (!dist || dist < 0) return "";
    return dist < 1
      ? `${Math.round(dist * 1000)} m`
      : `${dist.toFixed(1)} km`;
  }
  function esc(str) {
    if (!str) return "";
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function safeUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const u = new URL(url);
      return (u.protocol === "https:" || u.protocol === "http:") ? url : null;
    } catch (_) { return null; }
  }
  function titre(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  /* ======================================================
     INITIALISATION DES DATES
  ====================================================== */
  $("date-debut").value = todayISO();
  $("date-fin").value   = plusDays(30);

  /* ======================================================
     SLIDER RAYON
  ====================================================== */
  const slider = $("rayon-slider");
  const rayonVal = $("rayon-value");
  slider.addEventListener("input", () => {
    const v = slider.value;
    rayonVal.textContent = `${v} km`;
    slider.setAttribute("aria-valuetext", `${v} kilomètres`);
  });

  /* ======================================================
     ACCESSIBILITÉ — grand texte / contraste
  ====================================================== */
  $("btn-grand-texte").addEventListener("click", function () {
    const on = document.body.classList.toggle("grand-texte");
    this.setAttribute("aria-pressed", on);
  });
  $("btn-contraste").addEventListener("click", function () {
    const on = document.body.classList.toggle("contraste-eleve");
    this.setAttribute("aria-pressed", on);
  });

  /* ======================================================
     RECONNAISSANCE VOCALE (Speech-to-Text)
  ====================================================== */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btnMicro = $("btn-micro");
  const microLabel = $("micro-label");

  // Détection iOS (Safari) — interimResults instables, HTTPS requis en production
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window.MSStream);
  const isAndroid = /Android/.test(navigator.userAgent);

  if (!SR) {
    btnMicro.disabled = true;
    btnMicro.title = isIOS
      ? "Reconnaissance vocale disponible sur iOS 14.5+ via Safari (nécessite HTTPS)"
      : "Reconnaissance vocale non supportée — utilisez Chrome, Edge ou Safari";
    btnMicro.setAttribute("aria-disabled", "true");
  } else {
    const recog = new SR();
    recog.lang = "fr-FR";
    recog.continuous = false;
    recog.interimResults = !isIOS; // iOS Safari ne gère pas bien les résultats intermédiaires
    recog.maxAlternatives = 1;

    let enEcoute = false;

    recog.onstart = () => {
      enEcoute = true;
      btnMicro.classList.add("ecoute");
      microLabel.textContent = "J'écoute…";
      btnMicro.setAttribute("aria-label", "Écoute en cours — cliquez pour arrêter");
      $("geoloc-status").style.color = "#1a6b3a";
      $("geoloc-status").textContent = "🎤 Parlez maintenant : dites le nom de votre ville ou votre adresse…";
      $("adresse-input").value = "";
      lat = null; lng = null; villeNom = null;
    };

    recog.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map(r => r[0].transcript).join("").trim();

      // Commandes assistant via le micro normal
      if (/bonjour\s*don/i.test(transcript)) {
        recog.stop();
        setTimeout(() => ASSISTANT.startFlow(), 200);
        return;
      }
      if (/\b(au revoir don|bye don|quitter don|stop don)\b/i.test(transcript)
          || /\bstop\s+stop\b/i.test(transcript)) {
        recog.stop();
        ASSISTANT.quit();
        return;
      }
      if (/\b(aide(\s+don|\s*-?\s*moi)?|help don)\b/i.test(transcript)) {
        recog.stop();
        ASSISTANT.aide();
        return;
      }
      if (/\b(calibration don|r[eé]glage don|test micro|test don)\b/i.test(transcript)) {
        recog.stop();
        ASSISTANT.calibration();
        return;
      }

      $("adresse-input").value = transcript;
      if (e.results[e.results.length - 1].isFinal) {
        $("geoloc-status").textContent = `✓ Entendu : « ${transcript} »`;
        clearTimeout(autocompleteTimer);
        autocompleteTimer = setTimeout(() => fetchSuggestions(transcript), 100);
      }
    };

    recog.onerror = (e) => {
      const msgs = {
        "not-allowed":  "Accès au microphone refusé. Autorisez le micro dans les réglages de votre navigateur.",
        "no-speech":    "Aucune parole détectée. Veuillez réessayer.",
        "network":      "Erreur réseau lors de la reconnaissance vocale.",
        "audio-capture":"Aucun microphone détecté.",
      };
      $("geoloc-status").style.color = "var(--rouge)";
      $("geoloc-status").textContent = msgs[e.error] || `Erreur : ${e.error}`;
    };

    recog.onend = () => {
      enEcoute = false;
      btnMicro.classList.remove("ecoute");
      microLabel.textContent = "Dicter";
      btnMicro.setAttribute("aria-label", "Dicter l'adresse à voix haute");
    };

    btnMicro.addEventListener("click", () => {
      if (enEcoute) {
        recog.stop();
      } else {
        // Arrêter la synthèse en cours si besoin
        window.speechSynthesis && window.speechSynthesis.cancel();
        try { recog.start(); }
        catch (e) { /* déjà en cours */ }
      }
    });
  }

  /* ======================================================
     SYNTHÈSE VOCALE (Text-to-Speech)
  ====================================================== */
  const TTS = window.speechSynthesis;
  let lectureEnCours = false;
  let ttsResumeTimer = null;

  function parler(texte, onEnd) {
    if (!TTS) return;
    TTS.cancel();
    clearInterval(ttsResumeTimer);

    const utt = new SpeechSynthesisUtterance(texte);
    utt.lang = "fr-FR";
    utt.rate = 0.92;
    utt.pitch = 1;

    // Workaround iOS Safari : la synthèse vocale se met en pause après ~15s
    // Solution : appeler resume() toutes les 5s pendant la lecture
    utt.onstart = () => {
      lectureEnCours = true;
      if (isIOS) {
        ttsResumeTimer = setInterval(() => {
          if (TTS.paused) TTS.resume();
        }, 5000);
      }
    };
    utt.onend = utt.onerror = () => {
      clearInterval(ttsResumeTimer);
      lectureEnCours = false;
      if (onEnd) onEnd();
    };
    TTS.speak(utt);
  }

  function arreterLecture() {
    clearInterval(ttsResumeTimer);
    if (TTS) TTS.cancel();
    lectureEnCours = false;
    // Remettre tous les boutons de carte à leur état normal
    document.querySelectorAll(".btn-action.lire-carte.en-lecture")
      .forEach(b => {
        b.classList.remove("en-lecture");
        b.innerHTML = '<span aria-hidden="true">🔊</span> Lire';
        b.setAttribute("aria-label", b.dataset.lirelabel || "Lire cette fiche");
      });
  }

  function texteCartePermanent(item) {
    const types = [];
    if (item.giveBlood)    types.push("sang");
    if (item.givePlasma)   types.push("plasma");
    if (item.givePlatelet) types.push("plaquettes");
    const dist = item.distance ? `, à ${kmStr(item.distance)}` : "";
    let t = `${item.name || item.address1}${dist}. Adresse : ${item.fullAddress || item.address1}.`;
    if (types.length) t += ` Dons acceptés : ${types.join(", ")}.`;
    if (item.horaires) t += ` Horaires : ${item.horaires.replace(/\n/g, ". ")}.`;
    if (item.metro)   t += ` Métro : ${item.metro}.`;
    if (item.tram)    t += ` Tram : ${item.tram}.`;
    if (item.bus)     t += ` Bus : ${item.bus}.`;
    if (item.parking) t += ` Parking : ${item.parking}.`;
    if (item.phone) t += ` Téléphone : ${item.phone.replace(/(\d{2})(?=\d)/g, "$1 ")}.`;
    return t;
  }

  function texteCarteCollecte(item) {
    const dist = item.distance ? `, à ${kmStr(item.distance)}` : "";
    let t = `Collecte ${item.name || item.convocationLabel}${dist}. Adresse : ${item.address1}, ${item.postCode || ""} ${item.city || ""}.`;
    const sessions = (item.collections || []).slice(0, 3);
    if (sessions.length) {
      t += " Prochaines dates : ";
      t += sessions.map(c => {
        const h = [];
        if (c.morningStartTime) h.push(`${formatHeure(c.morningStartTime)} à ${formatHeure(c.morningEndTime)}`);
        if (c.afternoonStartTime) h.push(`${formatHeure(c.afternoonStartTime)} à ${formatHeure(c.afternoonEndTime)}`);
        return `${formatDateFR(c.date)}${h.length ? ", de " + h.join(" et ") : ""}`;
      }).join(". ");
      t += ".";
    }
    return t;
  }

  // Lit toutes les cartes en séquence
  function lireToutesLesCartes() {
    const cartes = Array.from(document.querySelectorAll(".carte[data-tts]"));
    if (!cartes.length) return;

    const cartesPerm = Array.from($("liste-permanents").querySelectorAll(".carte[data-tts]"));
    const cartesColl = Array.from($("liste-collectes").querySelectorAll(".carte[data-tts]"));
    const nbPerm = cartesPerm.length;
    const nbColl = cartesColl.length;

    let intro = `Résultats de recherche : `;
    if (nbPerm) {
      intro += `${nbPerm} site${nbPerm > 1 ? "s" : ""} permanent${nbPerm > 1 ? "s" : ""} : `;
      intro += cartesPerm.map(c => c.dataset.tts.split(".")[0]).join(". ") + ". ";
    }
    if (nbColl) {
      if (nbPerm) intro += `Et `;
      intro += `${nbColl} collecte${nbColl > 1 ? "s" : ""} mobile${nbColl > 1 ? "s" : ""} : `;
      intro += cartesColl.map(c => c.dataset.tts.split(".")[0]).join(". ") + ". ";
    }
    intro += "Je vais maintenant lire les détails. ";

    let idx = 0;
    function lireSuivante() {
      if (idx >= cartes.length || !lectureEnCours) return;
      const btn = cartes[idx].querySelector(".btn-action.lire-carte");
      if (btn) {
        document.querySelectorAll(".btn-action.lire-carte.en-lecture")
          .forEach(b => { b.classList.remove("en-lecture"); b.innerHTML = '<span aria-hidden="true">🔊</span> Lire'; });
        btn.classList.add("en-lecture");
        btn.innerHTML = '<span aria-hidden="true">▶</span> Lecture…';
        btn.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      parler(cartes[idx].dataset.tts, () => {
        if (btn) { btn.classList.remove("en-lecture"); btn.innerHTML = '<span aria-hidden="true">🔊</span> Lire'; }
        idx++;
        lireSuivante();
      });
    }

    lectureEnCours = true;
    parler(intro, lireSuivante);
  }

  if (TTS) {
    $("btn-lire-tout").addEventListener("click", () => {
      arreterLecture();
      lireToutesLesCartes();
    });
    $("btn-stop-lecture").addEventListener("click", arreterLecture);
  } else {
    $("btn-lire-tout").disabled = true;
    $("btn-lire-tout").title = "Synthèse vocale non supportée par ce navigateur";
  }

  /* ======================================================
     GÉOLOCALISATION
  ====================================================== */
  $("btn-geoloc").addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("Votre navigateur ne supporte pas la géolocalisation.");
      return;
    }
    const btn = $("btn-geoloc");
    btn.disabled = true;
    btn.textContent = "Localisation…";
    $("geoloc-status").textContent = "";

    navigator.geolocation.getCurrentPosition(
      async pos => {
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        villeNom = null;
        if (carteOk) map.setView([lat, lng], 13);
        $("geoloc-status").style.color = "var(--success)";
        $("geoloc-status").textContent = "📡 Position récupérée, identification de la ville…";

        // Reverse geocode via BAN pour obtenir le nom de ville
        // (l'endpoint searchnearpoint de l'EFS ne renvoie pas de résultats fiables)
        try {
          const r = await fetch(`${BAN_REVERSE}/?lon=${lng}&lat=${lat}`);
          if (r.ok) {
            const geoData = await r.json();
            const feat = geoData.features?.[0];
            if (feat) {
              villeNom = feat.properties.city || feat.properties.municipality || feat.properties.name;
            }
          }
        } catch (_) { /* silencieux — on utilisera searchnearpoint en fallback */ }

        const affichage = villeNom
          ? `📡 Ma position — ${villeNom}`
          : `📡 Position GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        $("adresse-input").value = affichage;
        $("geoloc-status").textContent = villeNom
          ? `✓ Position identifiée : ${villeNom} — vous pouvez lancer la recherche.`
          : "✓ Position récupérée — vous pouvez lancer la recherche.";
        btn.disabled = false;
        btn.innerHTML = '<span aria-hidden="true">📡</span> Ma position';
      },
      err => {
        $("geoloc-status").textContent = "Impossible d'obtenir la position : " + err.message;
        $("geoloc-status").style.color = "var(--rouge)";
        btn.disabled = false;
        btn.innerHTML = '<span aria-hidden="true">📡</span> Ma position';
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });

  /* ======================================================
     AUTOCOMPLETE ADRESSE (api-adresse.data.gouv.fr)
  ====================================================== */
  const input   = $("adresse-input");
  const listEl  = $("autocomplete-list");
  const wrapper = input.closest('[role="combobox"]');
  const backdrop = $("ac-backdrop");

  function clearSuggestions() {
    listEl.innerHTML = "";
    listEl.hidden = true;
    backdrop.style.display = "none";
    wrapper.setAttribute("aria-expanded", "false");
    selectedIndex = -1;
    suggestions = [];
  }

  async function fetchSuggestions(q) {
    if (q.length < 2) { clearSuggestions(); return; }
    try {
      const url = `${BAN_BASE}/?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`;
      const r = await fetch(url);
      if (!r.ok) return;
      const data = await r.json();
      suggestions = data.features || [];
      renderSuggestions(q);
    } catch (_) { /* silencieux */ }
  }

  function positionDropdown() {
    const rect = input.getBoundingClientRect();
    // Sur iOS avec clavier virtuel, utiliser visualViewport pour la hauteur disponible
    const vvH = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
    listEl.style.top   = (rect.bottom + 4) + "px";
    listEl.style.left  = rect.left + "px";
    listEl.style.width = rect.width + "px";
    const available = vvH - rect.bottom - 8;
    listEl.style.maxHeight = Math.min(200, Math.max(60, available)) + "px";
  }

  function renderSuggestions(query) {
    listEl.innerHTML = "";
    if (!suggestions.length) { clearSuggestions(); return; }

    positionDropdown();

    suggestions.forEach((feat, i) => {
      const label = feat.properties.label;
      const safeLabel = esc(label);
      const highlighted = safeLabel.replace(
        new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
        "<mark>$1</mark>"
      );
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("id", `ac-opt-${i}`);
      li.setAttribute("aria-selected", "false");
      li.innerHTML = highlighted;
      li.addEventListener("mousedown", e => {
        e.preventDefault();
        selectSuggestion(i);
      });
      listEl.appendChild(li);
    });

    listEl.hidden = false;
    backdrop.style.display = "block";
    wrapper.setAttribute("aria-expanded", "true");
    selectedIndex = -1;
  }

  function selectSuggestion(i) {
    const feat = suggestions[i];
    if (!feat) return;
    input.value = feat.properties.label;
    lat = feat.geometry.coordinates[1];
    lng = feat.geometry.coordinates[0];
    villeNom = feat.properties.city || feat.properties.municipality || feat.properties.name;
    $("geoloc-status").textContent = "";
    $("geoloc-status").style.color = "var(--success)";
    clearSuggestions();
    input.setAttribute("aria-activedescendant", "");
  }

  input.addEventListener("input", () => {
    lat = null; lng = null; villeNom = null;
    clearTimeout(autocompleteTimer);
    autocompleteTimer = setTimeout(() => fetchSuggestions(input.value.trim()), DEBOUNCE);
  });

  input.addEventListener("keydown", e => {
    if (listEl.hidden) return;
    const items = listEl.querySelectorAll("li");
    if (!items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      selectSuggestion(selectedIndex);
      return;
    } else if (e.key === "Escape") {
      clearSuggestions();
      return;
    }

    items.forEach((li, i) => {
      const sel = i === selectedIndex;
      li.setAttribute("aria-selected", sel);
      if (sel) input.setAttribute("aria-activedescendant", li.id);
    });
    if (selectedIndex >= 0) items[selectedIndex].scrollIntoView({ block: "nearest" });
  });

  // Backdrop click: close dropdown before the event reaches underlying elements
  backdrop.addEventListener("mousedown", e => {
    e.preventDefault(); // prevent input blur flip-flop
    clearSuggestions();
  });

  // Re-position dropdown on scroll, resize, ou changement clavier virtuel (iOS/Android)
  window.addEventListener("scroll", () => { if (!listEl.hidden) positionDropdown(); }, { passive: true });
  window.addEventListener("resize", () => { if (!listEl.hidden) positionDropdown(); }, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => { if (!listEl.hidden) positionDropdown(); });
    window.visualViewport.addEventListener("scroll", () => { if (!listEl.hidden) positionDropdown(); });
  }

  // Fallback: also close on blur (Tab key, programmatic focus moves)
  input.addEventListener("blur", () => setTimeout(clearSuggestions, 150));

  /* ======================================================
     GÉOCODAGE PAR TEXTE LIBRE (si pas de sélection)
  ====================================================== */
  async function geocodeAdresse(q) {
    const url = `${BAN_BASE}/?q=${encodeURIComponent(q)}&limit=1`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Géocodage impossible");
    const data = await r.json();
    if (!data.features?.length) throw new Error(`Adresse introuvable : « ${q} »`);
    const feat = data.features[0];
    lat = feat.geometry.coordinates[1];
    lng = feat.geometry.coordinates[0];
    villeNom = feat.properties.city || feat.properties.municipality || feat.properties.name;
  }

  /* ======================================================
     APPEL API EFS
  ====================================================== */
  async function fetchEFS() {
    const giveBlood      = $("filtre-sang").checked;
    const givePlasma     = $("filtre-plasma").checked;
    const givePlatelet   = $("filtre-plaquette").checked;
    const startDate      = $("date-debut").value;
    const endDate        = $("date-fin").value;
    const rayon          = slider.value;

    const params = new URLSearchParams({
      UserLatitude:  lat,
      UserLongitude: lng,
      GiveBlood:     giveBlood,
      GivePlasma:    givePlasma,
      GivePlatelet:  givePlatelet,
    });

    // Dates optionnelles
    if (startDate) params.set("StartDate", startDate);
    if (endDate)   params.set("EndDate",   endDate);

    let url;
    if (villeNom) {
      // Recherche par nom de ville (plus fiable avec l'API EFS)
      url = `${EFS_BASE}/samplingcollection/searchbycityname?cityName=${encodeURIComponent(villeNom)}&${params}`;
    } else {
      // Recherche par coordonnées GPS + rayon
      params.set("Radius", rayon);
      url = `${EFS_BASE}/samplingcollection/searchnearpoint?${params}`;
    }

    if (efsController) efsController.abort();
    efsController = new AbortController();

    const r = await fetch(url, { signal: efsController.signal });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Erreur serveur EFS (${r.status})${txt ? " : " + txt : ""}`);
    }
    return r.json();
  }

  /* ======================================================
     RENDU D'UNE CARTE LIEU PERMANENT
  ====================================================== */
  function renderPermanent(item) {
    const actions = [];
    {
      // Construire les liens RDV selon les types recherchés
      const rdvCandidats = [];
      if ($("filtre-sang").checked    && safeUrl(item.urlBlood))     rdvCandidats.push({ url: item.urlBlood,     label: "Sang" });
      if ($("filtre-plasma").checked  && safeUrl(item.urlPlasma))    rdvCandidats.push({ url: item.urlPlasma,    label: "Plasma" });
      if ($("filtre-plaquette").checked && safeUrl(item.urlPlatelets)) rdvCandidats.push({ url: item.urlPlatelets, label: "Plaquettes" });
      // Fallback : n'importe quelle URL si aucun filtre ne correspond
      if (!rdvCandidats.length) {
        const u = safeUrl(item.urlBlood) || safeUrl(item.urlPlasma) || safeUrl(item.urlPlatelets);
        if (u) rdvCandidats.push({ url: u, label: null });
      }
      const multiType = rdvCandidats.length > 1;
      rdvCandidats.forEach(({ url, label }) => {
        const ariaLabel = `Prendre rendez-vous${label ? " don de " + label.toLowerCase() : ""} à ${esc(item.name || item.address1)}`;
        const btnLabel  = multiType && label ? ` ${label}` : "";
        actions.push(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="btn-action rdv" aria-label="${ariaLabel}"><span aria-hidden="true">📅</span> RDV${btnLabel}</a>`);
      });
    }
    if (item.latitude && item.longitude) {
      const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.latitude},${item.longitude}`;
      actions.push(`<a href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer" class="btn-action maps" aria-label="Itinéraire vers ${esc(item.name || item.address1)}">
        <span aria-hidden="true">🗺️</span> Itinéraire
      </a>`);
    }
    if (item.phone) {
      actions.push(`<a href="tel:${esc(item.phone)}" class="btn-action tel" aria-label="Appeler le ${item.phone}">
        <span aria-hidden="true">📞</span> ${esc(item.phone)}
      </a>`);
    }

    const badges = [];
    if (item.giveBlood)    badges.push(`<span class="badge sang" aria-label="Don de sang disponible">🩸 Sang</span>`);
    if (item.givePlasma)   badges.push(`<span class="badge plasma" aria-label="Don de plasma disponible">💛 Plasma</span>`);
    if (item.givePlatelet) badges.push(`<span class="badge plaquette" aria-label="Don de plaquettes disponible">💜 Plaquettes</span>`);

    const details = [];
    if (item.horaires) details.push(`<div class="detail-ligne"><span class="detail-icone" aria-hidden="true">🕐</span><span class="detail-texte">${esc(item.horaires.trim())}</span></div>`);
    if (item.metro)    details.push(`<div class="detail-ligne"><span class="detail-icone" aria-hidden="true">🚇</span><span class="detail-texte">${esc(item.metro)}</span></div>`);
    if (item.bus)      details.push(`<div class="detail-ligne"><span class="detail-icone" aria-hidden="true">🚌</span><span class="detail-texte">Bus ${esc(item.bus)}</span></div>`);
    if (item.tram)     details.push(`<div class="detail-ligne"><span class="detail-icone" aria-hidden="true">🚊</span><span class="detail-texte">${esc(item.tram)}</span></div>`);
    if (item.parking)  details.push(`<div class="detail-ligne"><span class="detail-icone" aria-hidden="true">🅿️</span><span class="detail-texte">${esc(item.parking)}</span></div>`);
    if (item.infos)    details.push(`<div class="detail-ligne"><span class="detail-icone" aria-hidden="true">ℹ️</span><span class="detail-texte">${esc(item.infos)}</span></div>`);

    const distStr = kmStr(item.distance);
    const ttsText = texteCartePermanent(item);
    const lireLabel = `Lire à voix haute : ${item.name || item.address1}`;

    actions.push(`<button type="button" class="btn-action lire-carte" data-lirelabel="${esc(lireLabel)}" aria-label="${esc(lireLabel)}"><span aria-hidden="true">🔊</span> Lire</button>`);

    return `
    <article class="carte" role="listitem" aria-label="${esc(item.name || item.address1)}, à ${distStr}" data-tts="${esc(ttsText)}">
      <div class="carte-entete">
        <div class="carte-nom">${esc(item.name || item.address1)}</div>
        ${distStr ? `<span class="carte-distance" aria-label="Distance : ${distStr}">📍 ${distStr}</span>` : ""}
      </div>
      <p class="carte-adresse">
        <strong>${esc(item.address1)}</strong>${item.address2 ? "<br>" + esc(item.address2) : ""}
        <br>${esc(item.city || "")}
      </p>
      ${badges.length ? `<div class="badges" aria-label="Types de dons acceptés">${badges.join("")}</div>` : ""}
      ${details.length ? `<div class="carte-detail" aria-label="Informations pratiques">${details.join("")}</div>` : ""}
      ${actions.length ? `<div class="carte-actions">${actions.join("")}</div>` : ""}
    </article>`;
  }

  /* ======================================================
     RENDU D'UNE CARTE COLLECTE MOBILE
  ====================================================== */
  function renderCollecte(item) {
    const collections = (item.collections || []).sort((a, b) => new Date(a.date) - new Date(b.date));

    const sessionItems = collections.map(c => {
      const heures = [];
      if (c.morningStartTime && c.morningEndTime)
        heures.push(`${formatHeure(c.morningStartTime)} – ${formatHeure(c.morningEndTime)}`);
      if (c.afternoonStartTime && c.afternoonEndTime)
        heures.push(`${formatHeure(c.afternoonStartTime)} – ${formatHeure(c.afternoonEndTime)}`);

      const rdvLink = safeUrl(c.urlBlood) || safeUrl(c.urlPlasma) || safeUrl(c.urlPlatelet);
      const rdvBtn = rdvLink
        ? `<a href="${esc(rdvLink)}" target="_blank" rel="noopener noreferrer" class="btn-action rdv" style="margin-top:.4rem;font-size:.82rem;padding:.3rem .7rem;" aria-label="Prendre rendez-vous pour cette séance">📅 RDV</a>`
        : "";

      return `<li class="session-item" aria-label="Séance le ${formatDateFR(c.date)}">
        <div class="session-date">${formatDateFR(c.date)}</div>
        ${heures.length ? `<div class="session-horaire">🕐 ${heures.join(" et ")}</div>` : ""}
        ${c.nature ? `<div class="session-type">${esc(titre(c.nature))}</div>` : ""}
        ${rdvBtn}
      </li>`;
    }).join("");

    const badges = [];
    if (item.giveBlood)    badges.push(`<span class="badge sang">🩸 Sang</span>`);
    if (item.givePlasma)   badges.push(`<span class="badge plasma">💛 Plasma</span>`);
    if (item.givePlatelet) badges.push(`<span class="badge plaquette">💜 Plaquettes</span>`);

    const distStr = kmStr(item.distance);
    const ttsText = texteCarteCollecte(item);
    const lireLabel = `Lire à voix haute : collecte ${item.name || item.convocationLabel}`;

    const mapsUrl = item.latitude && item.longitude
      ? `https://www.google.com/maps/dir/?api=1&destination=${item.latitude},${item.longitude}`
      : null;

    return `
    <article class="carte" role="listitem" aria-label="Collecte à ${esc(item.name || item.convocationLabel)}, à ${distStr}" data-tts="${esc(ttsText)}">
      <div class="carte-entete">
        <div class="carte-nom">${esc(item.name || item.convocationLabel)}</div>
        ${distStr ? `<span class="carte-distance" aria-label="Distance : ${distStr}">📍 ${distStr}</span>` : ""}
      </div>
      <p class="carte-adresse">
        <strong>${esc(item.address1)}</strong>${item.address2 ? "<br>" + esc(item.address2) : ""}
        <br>${esc(item.postCode || "")} ${esc(item.city || "")}
      </p>
      ${badges.length ? `<div class="badges" aria-label="Types de dons">${badges.join("")}</div>` : ""}
      ${sessionItems ? `<ul class="sessions-liste" aria-label="Séances prévues">${sessionItems}</ul>` : ""}
      <div class="carte-actions">
        ${mapsUrl ? `<a href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer" class="btn-action maps" aria-label="Itinéraire vers ${esc(item.address1)}"><span aria-hidden="true">🗺️</span> Itinéraire</a>` : ""}
        <button type="button" class="btn-action lire-carte" data-lirelabel="${esc(lireLabel)}" aria-label="${esc(lireLabel)}"><span aria-hidden="true">🔊</span> Lire</button>
      </div>
    </article>`;
  }

  /* ======================================================
     RECHERCHE PRINCIPALE
  ====================================================== */
  async function rechercher() {
    const rl = RateLimit.check();
    if (!rl.ok) { showMsg("erreur", rl.msg); return; }

    const adresseVal = input.value.trim();
    if (!adresseVal) {
      showMsg("erreur", "Veuillez saisir une adresse ou utiliser la géolocalisation.");
      return;
    }

    // Validation des types avant tout appel réseau
    if (!$("filtre-sang").checked && !$("filtre-plasma").checked && !$("filtre-plaquette").checked) {
      showMsg("erreur", "Veuillez sélectionner au moins un type de don : sang, plasma ou plaquettes.");
      return;
    }

    // Si pas de coordonnées (pas d'autocomplete sélectionné), géocoder
    if (!lat || !lng) {
      showMsg("loading", "Recherche de votre adresse…");
      try {
        await geocodeAdresse(adresseVal);
      } catch (e) {
        showMsg("erreur", e.message);
        return;
      }
    }

    showMsg("loading", "Recherche des collectes en cours…");
    $("btn-rechercher").disabled = true;

    // Masquer résultats précédents
    $("section-permanents").hidden = true;
    $("section-collectes").hidden  = true;
    $("liste-permanents").innerHTML = "";
    $("liste-collectes").innerHTML  = "";
    $("compteur").textContent = "";

    try {
      const data = await fetchEFS();
      afficherResultats(data);
    } catch (e) {
      if (e.name === "AbortError") return;
      showMsg("erreur", "Impossible de contacter l'API EFS. Vérifiez votre connexion et réessayez.\n\nDétail : " + e.message);
    } finally {
      $("btn-rechercher").disabled = false;
    }
  }

  function afficherResultats(data) {
    hideMsg();
    arreterLecture();

    const permanents  = data.samplingLocationEntities_SF || [];
    const collectes   = data.samplingLocationCollections || [];
    const total = permanents.length + collectes.length;

    // Cacher le bandeau vocal en attendant
    const vocalBar = $("vocal-bar");
    vocalBar.classList.remove("visible");

    if (total === 0) {
      showMsg("vide", "Aucune collecte trouvée pour ces critères. Essayez d'élargir la période ou le rayon de recherche.");
      $("compteur").textContent = "";
      return;
    }

    const nbPerm = permanents.length, nbColl = collectes.length;
    $("compteur").textContent =
      `${total} résultat${total > 1 ? "s" : ""} trouvé${total > 1 ? "s" : ""} — ` +
      `${nbPerm} site${nbPerm > 1 ? "s" : ""} permanent${nbPerm > 1 ? "s" : ""}, ` +
      `${nbColl} collecte${nbColl > 1 ? "s" : ""} mobile${nbColl > 1 ? "s" : ""}`;

    if (nbPerm) {
      permanents.sort((a, b) => (a.distance || 99) - (b.distance || 99));
      $("liste-permanents").innerHTML = permanents.map(renderPermanent).join("");
      $("section-permanents").hidden = false;
      $("liste-permanents").querySelectorAll(".carte")
        .forEach((el, i) => el.setAttribute("data-map-id", `p-${i}`));
    }
    if (nbColl) {
      collectes.sort((a, b) => {
        const da = a.collections?.[0]?.date || "9999";
        const db = b.collections?.[0]?.date || "9999";
        return da < db ? -1 : da > db ? 1 : (a.distance || 99) - (b.distance || 99);
      });
      $("liste-collectes").innerHTML = collectes.map(renderCollecte).join("");
      $("section-collectes").hidden = false;
      $("liste-collectes").querySelectorAll(".carte")
        .forEach((el, i) => el.setAttribute("data-map-id", `c-${i}`));
    }

    updateMapMarkers(permanents, collectes);

    // Afficher le bandeau vocal si TTS disponible
    if (TTS) {
      $("vocal-bar-txt").textContent =
        `${total} résultat${total > 1 ? "s" : ""} — cliquez pour les écouter`;
      vocalBar.classList.add("visible");
    }

    // Délégation : boutons "Lire" individuels sur chaque carte
    [$("liste-permanents"), $("liste-collectes")].forEach(container => {
      container.addEventListener("click", e => {
        const btn = e.target.closest(".btn-action.lire-carte");
        if (!btn) return;
        const carte = btn.closest(".carte");
        if (!carte || !carte.dataset.tts) return;

        if (btn.classList.contains("en-lecture")) {
          arreterLecture();
          return;
        }
        arreterLecture();
        btn.classList.add("en-lecture");
        btn.innerHTML = '<span aria-hidden="true">▶</span> Lecture…';
        lectureEnCours = true;
        parler(carte.dataset.tts, () => {
          btn.classList.remove("en-lecture");
          btn.innerHTML = '<span aria-hidden="true">🔊</span> Lire';
        });
      });
    });

    // Focus sur le premier résultat pour les lecteurs d'écran
    const firstCard = document.querySelector(".carte");
    if (firstCard) {
      firstCard.setAttribute("tabindex", "-1");
      firstCard.focus({ preventScroll: false });
      firstCard.addEventListener("blur", () => firstCard.removeAttribute("tabindex"), { once: true });
    }
  }

  /* ======================================================
     MESSAGES DE STATUT
  ====================================================== */
  function showMsg(type, text) {
    const el = $("status-msg");
    el.className = type;
    if (type === "loading") {
      el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>`;
    } else {
      el.textContent = text;
    }
    el.style.display = "";
  }
  function hideMsg() {
    $("status-msg").style.display = "none";
    $("status-msg").className = "";
  }

  /* ======================================================
     CARTE LEAFLET
  ====================================================== */
  const MAP_FRANCE = [46.23, 2.21];
  const MAP_ZOOM   = 6;
  const MAX_MARQUEURS = 8;

  const carteOk = typeof L !== "undefined";
  let map, markersLayer;

  if (carteOk) {
    map = L.map("carte-map", {
      center: MAP_FRANCE,
      zoom: MAP_ZOOM,
      keyboard: true,
      scrollWheelZoom: false,   // activé seulement quand la carte a le focus clavier
    });

    map.on("focus", () => map.scrollWheelZoom.enable());
    map.on("blur",  () => map.scrollWheelZoom.disable());

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);

    // Centrage silencieux si la permission géoloc est déjà accordée
    if (navigator.permissions) {
      navigator.permissions.query({ name: "geolocation" }).then(r => {
        if (r.state === "granted") {
          navigator.geolocation.getCurrentPosition(
            pos => map.setView([pos.coords.latitude, pos.coords.longitude], 12),
            () => {}
          );
        }
      }).catch(() => {});
    }
  }

  const iconPerm = carteOk ? L.divIcon({
    className:    "map-marker-perm",
    html:         '<span aria-hidden="true">🏥</span>',
    iconSize:     [36, 36],
    iconAnchor:   [18, 36],
    popupAnchor:  [0, -38],
  }) : null;

  const iconColl = carteOk ? L.divIcon({
    className:    "map-marker-coll",
    html:         '<span aria-hidden="true">🚐</span>',
    iconSize:     [36, 36],
    iconAnchor:   [18, 36],
    popupAnchor:  [0, -38],
  }) : null;

  function scrollToCard(mapId) {
    const card = document.querySelector(`[data-map-id="${CSS.escape(mapId)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("asst-active");
    card.setAttribute("tabindex", "-1");
    card.focus({ preventScroll: true });
    setTimeout(() => { card.classList.remove("asst-active"); card.removeAttribute("tabindex"); }, 2000);
  }

  function updateMapMarkers(permanents, collectes) {
    if (!carteOk) return;
    markersLayer.clearLayers();

    // Fusion et sélection des 8 premiers items avec coordonnées
    const candidats = [
      ...permanents.map(s => ({ ...s, _type: "perm" })),
      ...collectes.map(s  => ({ ...s, _type: "coll" })),
    ].filter(s => s.latitude && s.longitude).slice(0, MAX_MARQUEURS);

    const bounds = [];
    candidats.forEach((item, i) => {
      const isPerm = item._type === "perm";
      const nom    = item.name || item.address1 || item.convocationLabel || "";
      const adresse = `${item.address1 || ""}, ${item.city || ""}`.trim().replace(/^,|,$/g, "");
      const mapId  = `${isPerm ? "p" : "c"}-${isPerm
        ? permanents.indexOf(permanents.find(p => p === item) ?? permanents[i])
        : collectes.indexOf(collectes.find(c => c === item) ?? collectes[i - permanents.filter(p => p.latitude && p.longitude).slice(0, MAX_MARQUEURS).length])}`;

      const popup = L.popup({ maxWidth: 240, className: "map-popup" });
      const marker = L.marker([item.latitude, item.longitude], {
        icon:  isPerm ? iconPerm : iconColl,
        title: nom,
        alt:   `${isPerm ? "Site permanent" : "Collecte mobile"} : ${nom}`,
      }).bindPopup(popup);

      marker.on("popupopen", () => {
        popup.setContent(
          `<div class="popup-titre">${esc(nom)}</div>` +
          `<div class="popup-adresse">${esc(adresse)}</div>` +
          `<button class="popup-voir">Voir la fiche</button>`
        );
        setTimeout(() => {
          popup.getElement()?.querySelector(".popup-voir")
            ?.addEventListener("click", () => { marker.closePopup(); scrollToCard(mapId); });
        }, 0);
      });

      marker.addTo(markersLayer);
      bounds.push([item.latitude, item.longitude]);
    });

    if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });

    const nb = candidats.length;
    $("carte-desc").textContent = nb
      ? `${nb} marqueur${nb > 1 ? "s" : ""} affiché${nb > 1 ? "s" : ""} sur la carte.`
      : "Aucun lieu géolocalisé à afficher sur la carte.";
  }

  /* ======================================================
     ASSISTANT VOCAL — Machine à états "Bonjour Don"
  ====================================================== */
  const ASSISTANT = (() => {
    let aState = "idle";   // idle | ask_loc | confirm_loc | searching | results | detail
    let allSites      = [];
    let curIdx        = -1;
    let recogA        = null;  // reconnaissance pour les séquences question/réponse
    let recogI        = null;  // reconnaissance parallèle pour les interruptions TTS
    let activeInterrupt = null;

    const panel   = $("assistant-panel");
    const etatEl  = $("asst-etat");
    const instrEl = $("asst-instr");
    const entEl   = $("asst-entendu");

    function setEtat(t)  { etatEl.textContent  = t; }
    function setInstr(t) { instrEl.textContent = t; }
    function setEnt(t)   { entEl.textContent   = t ? `💬 « ${t} »` : ""; }

    function show() { panel.hidden = false; }
    function hide() { panel.hidden = true;  aState = "idle"; allSites = []; curIdx = -1; }

    const AIDE_TEXTE =
      "Voici comment fonctionne l'assistant Don de sang. " +
      "Pour démarrer, cliquez sur le bouton Dicter puis dites « Bonjour Don ». " +
      "L'assistant vous demande votre ville ou votre adresse. " +
      "Vous pouvez aussi dire « ma position » pour utiliser le GPS. " +
      "Dites « oui » pour confirmer : la recherche se lance automatiquement. " +
      "Les résultats sont annoncés avec le nombre de sites et leur distance. " +
      "Pour le détail d'un lieu, dites « détail » suivi du numéro ou du nom ; " +
      "par exemple : « détail 1 » ou « détail maison du don ». " +
      "Pour naviguer entre les lieux, dites « lieu suivant » ou « lieu précédent ». " +
      "Pour prendre rendez-vous, dites « R D V » pendant la lecture du détail. " +
      "Pour quitter, dites « au revoir Don », « bye Don » ou « quitter Don ». " +
      "Pour répéter cette aide, dites « aide Don » à tout moment.";

    // Commandes globales interceptées dans tous les états (y compris pendant TTS)
    function globalCmd(a) {
      if (/\b(au revoir don|bye don|quitter don|stop don|sortir don)\b/i.test(a)
          || /\bstop\s+stop\b/i.test(a)) {
        stopInterrupt();
        arreterLecture();
        say("Au revoir, à bientôt pour votre prochain don !");
        setTimeout(hide, 2200);
        return true;
      }
      if (/\b(aide(\s+don|\s*-?\s*moi)?|help don)\b/i.test(a)) {
        stopInterrupt();
        say(AIDE_TEXTE, resumeState);
        return true;
      }
      if (/\b(calibration don|r[eé]glage don|test micro|test don)\b/i.test(a)) {
        stopInterrupt();
        if (recogA) { try { recogA.abort(); } catch (_) {} recogA = null; }
        startCalibration();
        return true;
      }
      return false;
    }

    // Reprend l'écoute du dernier état après l'aide
    function resumeState() {
      if      (aState === "ask_loc")     listenForLocation();
      else if (aState === "confirm_loc") listenForConfirmation();
      else if (aState === "results")     listenForNavigation();
      else if (aState === "detail")      listenInDetail();
    }

    // Parler puis lancer un callback quand la synthèse est terminée
    function say(text, cb) {
      setInstr(text);
      parler(text, cb);
    }

    // Bip de démarrage (montée 660→880 Hz) : "vous pouvez parler maintenant"
    function beepStart() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(660, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.28, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.18);
      } catch (_) {}
    }

    // Bip de fin (descente 880→440 Hz) : "j'ai arrêté d'écouter"
    function beepEnd() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.22, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.2);
      } catch (_) {}
    }

    // Lancer une session de reconnaissance et rappeler onResult(transcript, alternatives[])
    function hear(onResult, onSilence) {
      if (!SR) { say("La reconnaissance vocale n'est pas disponible sur ce navigateur."); return; }
      if (recogA) { try { recogA.abort(); } catch (_) {} }

      recogA = new SR();
      recogA.lang            = "fr-FR";
      recogA.continuous      = !isIOS;   // iOS ne supporte pas le mode continu
      recogA.interimResults  = !isIOS;   // résultats partiels pour feedback visuel
      recogA.maxAlternatives = 5;

      let silenceTimer = null;
      let gotFinal = false;
      let pendingAction = null; // différé à onend pour que le micro soit fermé avant le TTS

      function resetSilence() {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          if (!gotFinal) { try { recogA.stop(); } catch (_) {} }
        }, 6000);
      }

      recogA.onresult = evt => {
        const results = Array.from(evt.results);
        const last = results[results.length - 1];
        const alts = Array.from(last).map(r => r.transcript.trim().toLowerCase());

        if (!last.isFinal) {
          setEnt(alts[0] + " …");
          resetSilence();
          return;
        }

        clearTimeout(silenceTimer);
        gotFinal = true;
        const combined = results
          .filter(r => r.isFinal)
          .map(r => r[0].transcript.trim())
          .join(" ").toLowerCase();
        const allAlts = [combined, ...alts];
        setEnt(combined);

        beepEnd();
        try { recogA.stop(); } catch (_) {}
        // Ne pas appeler say()/TTS ici — attendre onend pour que Chrome ferme le micro
        // avant d'ouvrir la sortie audio (évite la suppression d'écho qui coupe le TTS)
        pendingAction = () => {
          if (globalCmd(allAlts.join(" "))) return;
          onResult(combined, allAlts);
        };
      };

      recogA.onerror = evt => {
        clearTimeout(silenceTimer);
        pendingAction = null;
        if (evt.error === "not-allowed") {
          say("Microphone refusé. Autorisez le micro dans les réglages du navigateur."); hide(); return;
        }
        if (evt.error === "no-speech") { if (onSilence) onSilence(); return; }
        if (onSilence) onSilence();
      };

      recogA.onend = () => {
        clearTimeout(silenceTimer);
        if (pendingAction) {
          const action = pendingAction; pendingAction = null;
          // 80ms de délai supplémentaire pour que Chrome bascule audio mic→haut-parleur
          setTimeout(action, 80);
        }
      };

      setEtat("🎤 J'écoute… (parlez après le bip)");
      beepStart(); // bip montant avant ouverture du micro
      // Délai 220ms : laisser le bip se terminer avant d'activer le micro
      // (évite que l'écho-cancellation Chrome supprime le bip)
      setTimeout(() => {
        resetSilence();
        try { recogA.start(); } catch (_) {}
      }, 220);
    }

    // Normalise un texte pour la comparaison floue
    function norm(s) {
      return (s || "").toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    }

    // Trouve l'index du site dont le nom ressemble le plus à query
    function findSite(query) {
      const q = norm(query);
      const words = q.split(" ").filter(w => w.length > 2);
      let best = -1, bestScore = 0;
      allSites.forEach((s, i) => {
        const name = norm(s.name || s.address1 || s.convocationLabel || "");
        const score = words.length
          ? words.filter(w => name.includes(w)).length / words.length
          : 0;
        if (score > bestScore && score >= 0.35) { bestScore = score; best = i; }
      });
      return best;
    }

    // URL RDV pertinente selon les filtres actifs
    function rdvUrl(s) {
      const gS = $("filtre-sang").checked, gP = $("filtre-plasma").checked, gPl = $("filtre-plaquette").checked;
      if (s.type === "permanent") {
        const raw = (gS && s.urlBlood) || (gP && s.urlPlasma) || (gPl && s.urlPlatelets)
                 || s.urlBlood || s.urlPlasma || s.urlPlatelets;
        return safeUrl(raw);
      }
      // Collecte : RDV par séance
      for (const c of (s.collections || [])) {
        const raw = (gS && c.urlBlood) || (gP && c.urlPlasma) || (gPl && c.urlPlatelet)
                 || c.urlBlood || c.urlPlasma || c.urlPlatelet;
        const u = safeUrl(raw);
        if (u) return u;
      }
      return null;
    }

    // Texte du résumé global
    function summaryText() {
      const nb   = allSites.length;
      if (!nb) return "Aucun résultat trouvé pour cette recherche.";
      const perms = allSites.filter(s => s.type === "permanent");
      const colls = allSites.filter(s => s.type === "collecte");
      let t = `J'ai trouvé ${nb} résultat${nb > 1 ? "s" : ""}. `;
      if (perms.length) {
        t += `${perms.length} site${perms.length > 1 ? "s" : ""} permanent${perms.length > 1 ? "s" : ""} : `;
        t += perms.map((s, i) => `numéro ${i + 1}, ${s.name || s.address1}${s.distance ? ", à " + kmStr(s.distance) : ""}`).join(". ") + ". ";
      }
      if (colls.length) {
        const off = perms.length;
        t += `${colls.length} collecte${colls.length > 1 ? "s" : ""} mobile${colls.length > 1 ? "s" : ""} : `;
        t += colls.map((s, i) => `numéro ${off + i + 1}, ${s.name || s.convocationLabel}${s.distance ? ", à " + kmStr(s.distance) : ""}`).join(". ") + ". ";
      }
      t += `Dites « détail » suivi du numéro ou du nom, ou « lieu suivant » pour commencer la lecture.`;
      return t;
    }

    // ---- ÉTATS ----

    function startFlow() {
      aState = "ask_loc";
      lat = null; lng = null; villeNom = null;
      input.value = "";
      show();
      setEtat("Démarrage…");
      say(
        "Bonjour ! Je suis votre assistant don de sang. Dites le nom de votre ville ou votre adresse, ou dites « ma position » pour utiliser votre GPS.",
        listenForLocation
      );
    }

    // Calibration vocale — aide l'utilisateur à ajuster son élocution
    // Déclenché par "calibration don" ou "réglage don"
    function startCalibration() {
      const phrases = [
        { attendu: "oui",     texte: "Dites « oui »" },
        { attendu: "rennes",  texte: "Dites le nom d'une ville, par exemple « Rennes »" },
        { attendu: "suivant", texte: "Dites « suivant »" },
      ];
      let idx = 0;

      show(); setEtat("🎙️ Calibration vocale");

      function etape() {
        if (idx >= phrases.length) {
          say("Calibration terminée. Votre micro semble bien configuré. Vous pouvez maintenant dire « Bonjour Don » pour démarrer.", hide);
          return;
        }
        const p = phrases[idx];
        say(`Étape ${idx + 1} sur ${phrases.length}. ${p.texte}. Parlez après le bip.`, () => {
          hear(
            (t) => {
              const ok = norm(t).includes(norm(p.attendu));
              say(
                ok ? `Parfait, j'ai bien entendu « ${t} ». `
                   : `J'ai entendu « ${t} ». Si ce n'est pas ce que vous avez dit, parlez plus lentement et distinctement. `,
                () => { idx++; etape(); }
              );
            },
            () => {
              say("Je n'ai rien entendu. Vérifiez que votre micro est bien autorisé, puis réessayons.", () => etape());
            }
          );
        });
      }

      say("Démarrage de la calibration vocale. Je vais vous demander de répéter quelques mots pour vérifier que votre micro fonctionne bien.", etape);
    }

    function listenForLocation() {
      aState = "ask_loc";
      setEtat("🎤 En attente d'une adresse");
      setInstr("Dites votre ville, votre adresse, ou « ma position »");
      hear(
        (t, all) => {
          const a = all.join(" ");
          if (/\b(ma position|gps|localisation|géoloc)\b/i.test(a)) {
            handleMyPosition();
          } else {
            handleCityName(t);
          }
        },
        () => say("Je n'ai rien entendu. Dites votre ville ou « ma position ».", listenForLocation)
      );
    }

    async function handleCityName(txt) {
      setEtat("Géocodage…");
      say(`Recherche de « ${txt} »…`);
      try {
        await geocodeAdresse(txt);
        input.value = villeNom || txt;
        aState = "confirm_loc";
        say(
          `J'ai trouvé ${villeNom || txt}. Confirmez-vous ? Dites « oui » pour lancer la recherche ou « non » pour changer d'adresse.`,
          listenForConfirmation
        );
      } catch (_) {
        say("Je n'ai pas trouvé cette adresse. Précisez votre ville ou dites « ma position ».", listenForLocation);
      }
    }

    function handleMyPosition() {
      setEtat("Localisation GPS…");
      say("Récupération de votre position GPS…");
      if (!navigator.geolocation) {
        say("La géolocalisation n'est pas disponible. Dites votre ville.", listenForLocation); return;
      }
      navigator.geolocation.getCurrentPosition(
        async pos => {
          lat = pos.coords.latitude; lng = pos.coords.longitude; villeNom = null;
          try {
            const r = await fetch(`${BAN_REVERSE}/?lon=${lng}&lat=${lat}`);
            if (r.ok) {
              const d = await r.json();
              const f = d.features?.[0];
              if (f) villeNom = f.properties.city || f.properties.municipality || f.properties.name;
            }
          } catch (_) {}
          input.value = villeNom ? `📡 Ma position — ${villeNom}` : `📡 (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
          aState = "confirm_loc";
          say(
            `Position GPS récupérée${villeNom ? " : " + villeNom : ""}. Confirmez-vous ? Dites « oui » pour lancer la recherche ou « non » pour changer.`,
            listenForConfirmation
          );
        },
        err => say(`Impossible d'obtenir la position : ${err.message}. Dites votre ville.`, listenForLocation),
        { timeout: 10000, enableHighAccuracy: true }
      );
    }

    function listenForConfirmation() {
      aState = "confirm_loc";
      setEtat("🎤 Confirmation");
      setInstr("Dites « oui » pour confirmer ou « non » pour changer d'adresse");
      hear(
        (t, all) => {
          const a = all.join(" ");
          if (/\b(oui|ok|ouais|confirme|correct|parfait|lancer|c'est ça|oké|yes)\b/i.test(a)) {
            launchSearch();
          } else if (/\b(non|no|recommence|retour|change|autre|annule|non pas)\b/i.test(a)) {
            lat = null; lng = null; villeNom = null; input.value = "";
            say("D'accord. Dites une nouvelle adresse ou « ma position ».", listenForLocation);
          } else {
            say("Je n'ai pas compris. Dites « oui » pour confirmer ou « non » pour changer.", listenForConfirmation);
          }
        },
        () => say("Confirmez-vous cette position ? Dites « oui » ou « non ».", listenForConfirmation)
      );
    }

    async function launchSearch() {
      const rl = RateLimit.check();
      if (!rl.ok) {
        say(rl.msg + " Dites « réessayer » quand vous êtes prêt.", () => {
          hear(
            (t, all) => {
              if (/\b(réessayer|réessaie|retenter|oui|ok|prêt)\b/i.test(all.join(" "))) launchSearch();
              else listenForConfirmation();
            },
            () => listenForConfirmation()
          );
        });
        return;
      }
      aState = "searching";
      setEtat("Recherche en cours…");
      say("Lancement de la recherche, un instant…");
      if (!$("filtre-sang").checked && !$("filtre-plasma").checked && !$("filtre-plaquette").checked) {
        $("filtre-sang").checked = $("filtre-plasma").checked = $("filtre-plaquette").checked = true;
      }
      try {
        const data = await fetchEFS();
        afficherResultats(data);
        const perms = (data.samplingLocationEntities_SF || []).map(s => ({ ...s, type: "permanent" }));
        const colls = (data.samplingLocationCollections || []).map(s => ({ ...s, type: "collecte" }));
        allSites = [...perms, ...colls];
        curIdx = -1;
        aState = "results";
        // Scroller vers les résultats pour que l'utilisateur voie les cartes
        $("resultats").scrollIntoView({ behavior: "smooth", block: "start" });
        say(summaryText(), listenForNavigation);
      } catch (e) {
        if (e.name === "AbortError") return;
        say("Impossible de contacter le serveur EFS. Dites « réessayer » ou « quitter ».", () => {
          hear(
            (t, all) => {
              if (/\b(réessayer|réessaie|retenter|oui|ok)\b/i.test(all.join(" "))) launchSearch();
              else { say("À bientôt."); hide(); }
            },
            () => { say("À bientôt."); hide(); }
          );
        });
      }
    }

    function listenForNavigation() {
      if (aState !== "results") return;
      setEtat("🎤 Navigation dans les résultats");
      setInstr("Dites « détail » + numéro/nom, « lieu suivant » ou « recommencer »");
      hear(
        (t, all) => {
          const a = all.join(" ");
          // "détail 2" ou "detail 2"
          const mNum = (a.match(/d[eé]tail\s+(\d+)/i));
          if (mNum) {
            const idx = parseInt(mNum[1]) - 1;
            if (idx >= 0 && idx < allSites.length) { curIdx = idx; readDetail(); }
            else say(`Je n'ai pas de lieu numéro ${mNum[1]}.`, listenForNavigation);
            return;
          }
          // "lieu suivant" ou juste "suivant" → démarre au 1er lieu
          if (/\b(suivant|prochain|premier|un)\b/i.test(a)) {
            curIdx = (curIdx < 0) ? 0 : Math.min(curIdx + 1, allSites.length - 1);
            readDetail(); return;
          }
          if (/\b(pr[eé]c[eé]dent|avant)\b/i.test(a)) {
            curIdx = Math.max(0, curIdx - 1); readDetail(); return;
          }
          if (/\b(recommenc|nouvelle|quitter|stop|sortir)\b/i.test(a)) {
            say("Nouvelle recherche.", startFlow); return;
          }
          // "détail [nom]"
          const mNom = a.match(/d[eé]tail\s+(.+)/i);
          if (mNom) {
            const idx = findSite(mNom[1]);
            if (idx >= 0) { curIdx = idx; readDetail(); return; }
          }
          say("Je n'ai pas compris. Dites « détail » suivi du numéro ou du nom, ou « lieu suivant ».", listenForNavigation);
        },
        () => listenForNavigation()   // silence : ré-écouter silencieusement
      );
    }

    // Mots-clés qui interrompent la lecture TTS en cours
    function isInterruptCmd(a) {
      return /\b(suivant|prochain|pr[eé]c[eé]dent|avant|stop|pause|arr[eê]te|reprise|reprendre|d[eé]but|relire|rdv|rendez.vous|retour|liste|quitter don|au revoir don|bye don|aide(\s+don|\s*-?\s*moi)?|help don)\b/i.test(a);
    }

    // Arrête le listener d'interruption
    function stopInterrupt() {
      if (activeInterrupt) { activeInterrupt.stop(); activeInterrupt = null; }
      if (recogI) { try { recogI.abort(); } catch (_) {} recogI = null; }
    }

    // Lance un recognizer en mode continu pendant le TTS pour détecter les interruptions sans gap
    function startInterruptListener(onInterrupt) {
      stopInterrupt();
      if (!SR) return;
      let active = true;

      function launch() {
        if (!active) return;
        if (recogI) { try { recogI.abort(); } catch (_) {} }
        recogI = new SR();
        recogI.lang            = "fr-FR";
        recogI.continuous      = true;   // pas de gap : une seule session persistante
        recogI.interimResults  = false;  // uniquement les résultats finaux (plus fiables)
        recogI.maxAlternatives = 5;

        recogI.onresult = evt => {
          if (!active) return;
          const last = evt.results[evt.results.length - 1];
          if (!last.isFinal) return;
          const alts = Array.from(last).map(r => r.transcript.trim().toLowerCase());
          setEnt(alts[0]);
          const a = alts.join(" ");
          if (isInterruptCmd(a)) {
            active = false; activeInterrupt = null;
            try { recogI.stop(); } catch (_) {} recogI = null;
            onInterrupt(a, alts);
          }
          // Mot non reconnu comme commande : continuer à écouter (mode continu)
        };
        // Le navigateur peut terminer la session par inactivité → relancer
        recogI.onerror = () => { if (active) setTimeout(launch, 500); };
        recogI.onend   = () => { if (active) setTimeout(launch, 200); };

        try { recogI.start(); } catch (_) { setTimeout(launch, 700); }
      }

      launch();
      activeInterrupt = {
        stop: () => { active = false; if (recogI) { try { recogI.abort(); } catch (_) {} recogI = null; } activeInterrupt = null; }
      };
    }

    // Met en surbrillance la carte à l'index donné et scrolle vers elle (-1 = effacer tout)
    function highlightCard(idx) {
      document.querySelectorAll(".carte.asst-active")
        .forEach(el => el.classList.remove("asst-active"));
      if (idx < 0) return;
      const cartes = document.querySelectorAll(".carte");
      const card = cartes[idx];
      if (!card) return;
      card.classList.add("asst-active");
      // Décalage pour que le panel assistant ne cache pas la carte
      const panelH = $("assistant-panel").hidden ? 0 : $("assistant-panel").offsetHeight + 8;
      const rect = card.getBoundingClientRect();
      const scrollTarget = window.scrollY + rect.top - panelH - 16;
      window.scrollTo({ top: scrollTarget, behavior: "smooth" });
    }

    function readDetail() {
      aState = "detail";
      const s = allSites[curIdx];
      if (!s) return;
      const u = rdvUrl(s);
      let text = s.type === "permanent" ? texteCartePermanent(s) : texteCarteCollecte(s);
      const hints = [];
      if (u)                            hints.push("« RDV »");
      if (curIdx < allSites.length - 1) hints.push("« suivant »");
      if (curIdx > 0)                   hints.push("« précédent »");
      hints.push("« stop » pour interrompre");
      hints.push("« retour »");
      text += ` Commandes : ${hints.join(", ")}.`;

      setEtat(`📍 Lieu ${curIdx + 1} / ${allSites.length}`);
      setInstr(text);

      highlightCard(curIdx);

      if (!TTS) { listenInDetail(); return; }
      stopInterrupt();
      TTS.cancel();
      clearInterval(ttsResumeTimer);

      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = "fr-FR"; utt.rate = 0.92; utt.pitch = 1;

      utt.onstart = () => {
        lectureEnCours = true;
        if (isIOS) { ttsResumeTimer = setInterval(() => { if (TTS.paused) TTS.resume(); }, 5000); }
        // Démarrer l'écoute d'interruption après que le TTS est bien lancé
        setTimeout(() => {
          if (aState === "detail") {
            startInterruptListener((a, alts) => {
              TTS.cancel();
              clearInterval(ttsResumeTimer);
              lectureEnCours = false;
              execDetailCmd(a, alts);
            });
          }
        }, 800);
      };

      utt.onend = () => {
        clearInterval(ttsResumeTimer);
        lectureEnCours = false;
        stopInterrupt();
        if (aState === "detail") listenInDetail();
      };

      utt.onerror = () => {
        clearInterval(ttsResumeTimer);
        lectureEnCours = false;
        stopInterrupt();
        if (aState === "detail") listenInDetail();
      };

      TTS.speak(utt);
    }

    // Traite une commande détail — appelée à la fois par l'interruption ET par listenInDetail
    function execDetailCmd(a, all) {
      const b = (all || [a]).join(" ");
      if (globalCmd(b)) return;
      if (/\b(rdv|rendez.vous|prendre rendez|rendez vous)\b/i.test(b)) { openRDV(); return; }
      if (/\b(suivant|prochain|après)\b/i.test(b)) {
        if (curIdx < allSites.length - 1) { curIdx++; readDetail(); }
        else say("C'est le dernier lieu.", listenInDetail);
        return;
      }
      if (/\b(pr[eé]c[eé]dent|avant)\b/i.test(b)) {
        if (curIdx > 0) { curIdx--; readDetail(); }
        else say("C'est le premier lieu.", listenInDetail);
        return;
      }
      if (/\b(stop|pause|arr[eê]te)\b/i.test(b)) {
        say("Lecture interrompue. Dites « reprise » pour relire depuis le début, ou une autre commande.", listenForPauseCmd);
        return;
      }
      if (/\b(reprise|reprendre|d[eé]but|relire|recommence)\b/i.test(b)) {
        readDetail(); return;
      }
      if (/\b(retour|r[eé]sultats|liste|r[eé]sum[eé])\b/i.test(b)) {
        aState = "results";
        highlightCard(-1);
        $("resultats").scrollIntoView({ behavior: "smooth", block: "start" });
        say("Retour aux résultats.", listenForNavigation);
        return;
      }
      say("Commande non reconnue. Dites « RDV », « suivant », « précédent », « stop » ou « retour ».", listenInDetail);
    }

    // État intermédiaire après un "stop" : attend "reprise" ou autre commande
    function listenForPauseCmd() {
      setEtat("⏸ En pause");
      setInstr("Dites « reprise » pour relire, ou une autre commande");
      hear(
        (t, all) => {
          if (/\b(reprise|reprendre|d[eé]but|relire)\b/i.test(all.join(" "))) { readDetail(); return; }
          execDetailCmd(t, all);
        },
        () => listenForPauseCmd()
      );
    }

    function listenInDetail() {
      if (aState !== "detail") return;
      setEtat(`🎤 Lieu ${curIdx + 1} — commandes`);
      setInstr("Dites « RDV », « suivant », « précédent », « stop » ou « retour »");
      hear(
        (t, all) => execDetailCmd(t, all),
        () => listenInDetail()
      );
    }

    function openRDV() {
      const u = rdvUrl(allSites[curIdx]);
      if (u) { window.open(u, "_blank", "noopener,noreferrer"); say("Ouverture de la page de rendez-vous.", listenInDetail); }
      else     say("Pas de lien de rendez-vous disponible pour ce lieu.", listenInDetail);
    }

    // Bouton quitter (équivalent de "au revoir don")
    $("asst-quitter").addEventListener("click", () => {
      if (recogA) { try { recogA.abort(); } catch (_) {} recogA = null; }
      stopInterrupt();
      arreterLecture();
      say("Au revoir, à bientôt pour votre prochain don !");
      setTimeout(hide, 2200);
    });

    function quit() {
      if (aState !== "idle") {
        if (recogA) { try { recogA.abort(); } catch (_) {} recogA = null; }
        stopInterrupt();
        arreterLecture();
        say("Au revoir, à bientôt pour votre prochain don !");
        setTimeout(hide, 2200);
      }
    }

    function aide() {
      if (aState === "idle") {
        show(); setEtat("Aide");
        say(AIDE_TEXTE, hide);
      } else {
        say(AIDE_TEXTE, resumeState);
      }
    }

    return { startFlow, hide, quit, aide, calibration: startCalibration };
  })();

  $("btn-rechercher").addEventListener("click", rechercher);

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && listEl.hidden) rechercher();
  });

})();
