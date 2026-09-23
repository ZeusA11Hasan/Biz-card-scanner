const API_URL = window.FOLIO_API_URL || '/api';
const AUTH_TOKEN_KEY = 'folio_auth_token';
const AUTH_COOKIE_KEY = 'folio_token';
const AUTH_USER_CACHE_KEY = 'folio_auth_user';
const AUTH_MAX_AGE = 90 * 24 * 60 * 60;
const TEMP_USER_ID = 'local-dev-user';
// API Configuration done by deploy.sh (assumed to be injected via deploy.sh)
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded');

    // Initialize contacts array in memory
    let contactsData = [];
    let isLoadingContacts = false;
    let loadContactsPromise = null;
    
    // Initialize chart objects
    window.companyDistributionChart = null;
    window.industryInsightsChart = null;
    let authReady = false;
    let authCheckPromise = null;
    let initializeAppPromise = null;
    let ignoreDetailPopUntil = 0;
    let phoneSaveSourceContact = null;
    
    // Check if Chart.js is available
    if (typeof Chart === 'undefined') {
        console.error('Chart.js is not loaded properly. Loading from CDN...');
        // Try to load Chart.js dynamically
        const chartScript = document.createElement('script');
        chartScript.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';
        chartScript.onload = () => console.log('Chart.js loaded dynamically');
        chartScript.onerror = (e) => console.error('Failed to load Chart.js dynamically', e);
        document.head.appendChild(chartScript);
    } else {
        console.log('Chart.js is available');
    }

    // DOM elements
    const resetBtn = document.getElementById('resetBtn');
    const previewImage = document.getElementById('previewImage');
    const processingStatus = document.getElementById('processingStatus');
    const fileUpload = document.getElementById('fileUpload');
    const contactsList = document.getElementById('contactsList');
    const noContacts = document.getElementById('noContacts');
    const contactsLoading = document.getElementById('contactsLoading');
    const searchContacts = document.getElementById('searchContacts');
    const filterByTag = document.getElementById('filterByTag');
    const filterByIndustry = document.getElementById('filterByIndustry');
    const filterFollowUp = document.getElementById('filterFollowUp');
    const followUpHint = document.getElementById('followUpHint');
    const sortContacts = document.getElementById('sortContacts');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const myCardBtn = document.getElementById('myCardBtn');
    const myCardContent = document.getElementById('myCardContent');
    const publicCardContent = document.getElementById('publicCardContent');
    const CONTACTS_IDB_NAME = 'folio_offline';
    const CONTACTS_IDB_STORE = 'contacts_cache';
    const MY_CARD_PREFIX = 'folio_my_card_';

    function normalizeEmail(email) {
        return (email || '').trim().toLowerCase();
    }

    function normalizePhone(phone) {
        return (phone || '').toString().replace(/\D/g, '');
    }

    function escapeVCardValue(value) {
        return (value || '').toString()
            .replace(/\\/g, '\\\\')
            .replace(/\r\n/g, '\\n')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\n')
            .replace(/,/g, '\\,')
            .replace(/;/g, '\\;');
    }

    function normalizeHref(value) {
        const raw = (value || '').trim();
        if (!raw) return '';
        if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
        return `https://${raw}`;
    }

    function splitPersonName(fullName) {
        const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return { first: '', last: '' };
        if (parts.length === 1) return { first: parts[0], last: '' };
        return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
    }

    function phoneNumbers(phone) {
        return String(phone || '')
            .split(/[/|,;]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    }

    function firstPhoneNumber(phone) {
        const listed = phoneNumbers(phone);
        const raw = listed[0] || String(phone || '').trim();
        return raw.replace(/[^\d+]/g, '') || raw;
    }

    function buildVCard(person) {
        const name = person.name || '';
        const { first, last } = splitPersonName(name);
        const lines = [
            'BEGIN:VCARD',
            'VERSION:3.0',
        ];
        if (name) {
            lines.push(`N:${escapeVCardValue(last)};${escapeVCardValue(first)};;;`);
            lines.push(`FN:${escapeVCardValue(name)}`);
        }
        if (person.company) lines.push(`ORG:${escapeVCardValue(person.company)}`);
        if (person.title) lines.push(`TITLE:${escapeVCardValue(person.title)}`);
        if (person.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${escapeVCardValue(person.email)}`);
        phoneNumbers(person.phone).forEach((phone, index) => {
            const type = index === 0 ? 'CELL,VOICE' : 'VOICE';
            lines.push(`TEL;TYPE=${type}:${escapeVCardValue(phone)}`);
        });
        if (person.address) lines.push(`ADR;TYPE=WORK:;;${escapeVCardValue(person.address)};;;`);
        if (person.website) lines.push(`URL:${escapeVCardValue(normalizeHref(person.website))}`);
        if (person.profileUrl) lines.push(`URL:${escapeVCardValue(person.profileUrl)}`);
        ['linkedin', 'twitter', 'instagram', 'github'].forEach((key) => {
            const href = normalizeHref(person[key]);
            if (href) lines.push(`URL;TYPE=${key}:${escapeVCardValue(href)}`);
        });
        const photo = person.avatar || person.avatarUrl || '';
        if (/^https?:/i.test(photo)) lines.push(`PHOTO;VALUE=URI:${photo}`);
        const note = person.bio || person.notes;
        if (note) lines.push(`NOTE:${escapeVCardValue(note)}`);
        lines.push('END:VCARD');
        return lines.join('\r\n');
    }

    function contactShareText(person) {
        return [
            person.name,
            [person.title, person.company].filter(Boolean).join(' · '),
            person.email,
            person.phone,
            person.website || person.linkedin,
        ].filter(Boolean).join('\n');
    }

    function downloadBlob(blob, filename) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }

    async function shareVCardContent(vcardContent, person, filename) {
        const safeName = (filename || person.name || 'contact').replace(/[^\w.-]+/g, '_');
        const fileName = safeName.endsWith('.vcf') ? safeName : `${safeName}.vcf`;
        const blob = new Blob([vcardContent], { type: 'text/vcard' });
        const file = new File([blob], fileName, { type: 'text/vcard' });
        const shareData = {
            title: person.name || 'Contact',
            text: contactShareText(person),
            files: [file],
        };
        try {
            if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
                await navigator.share(shareData);
                return 'shared';
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return 'aborted';
        }
        try {
            if (navigator.share) {
                await navigator.share({ title: person.name || 'Contact', text: contactShareText(person) });
                return 'shared-text';
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return 'aborted';
        }
        downloadBlob(blob, fileName);
        await copyTextToClipboard(contactShareText(person));
        return 'fallback';
    }

    function findDuplicateContacts(newContact, allContacts) {
        const email = normalizeEmail(newContact.email);
        const phone = normalizePhone(newContact.phone);
        return (allContacts || []).filter((c) => {
            if (!c || c.cardId === newContact.cardId) return false;
            const emailMatch = email && normalizeEmail(c.email) === email;
            const phoneMatch = phone && phone.length >= 7 && normalizePhone(c.phone) === phone;
            return emailMatch || phoneMatch;
        });
    }

    function warnIfDuplicates(newContacts) {
        const pool = [...contactsData];
        (newContacts || []).forEach((nc) => {
            if (!nc) return;
            const dups = findDuplicateContacts(nc, pool);
            if (dups.length) {
                const names = dups.map((d) => d.name || 'Unknown').slice(0, 3).join(', ');
                showToast(`Possible duplicate: ${nc.name || 'New contact'} matches ${names}`, 'warning');
            }
            pool.push(nc);
        });
    }

    function parseTagsInput(value) {
        if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
        return String(value || '').split(',').map((t) => t.trim()).filter(Boolean);
    }

    function getFollowUpStatus(followUpDate) {
        if (!followUpDate) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const due = new Date(followUpDate + 'T00:00:00');
        if (Number.isNaN(due.getTime())) return null;
        const diffDays = Math.round((due - today) / 86400000);
        if (diffDays < 0) return 'overdue';
        if (diffDays <= 7) return 'dueSoon';
        return 'upcoming';
    }

    function formatFollowUpLabel(followUpDate) {
        const status = getFollowUpStatus(followUpDate);
        if (!status) return '';
        if (status === 'overdue') return `Overdue ${followUpDate}`;
        if (status === 'dueSoon') return `Due ${followUpDate}`;
        return `Follow-up ${followUpDate}`;
    }

    function myCardStorageKey() {
        return `${MY_CARD_PREFIX}${userId || TEMP_USER_ID}`;
    }

    function loadMyCard() {
        try {
            const raw = localStorage.getItem(myCardStorageKey());
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function saveMyCard(card) {
        localStorage.setItem(myCardStorageKey(), JSON.stringify(card));
    }

    function openContactsIdb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(CONTACTS_IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CONTACTS_IDB_STORE)) {
                    db.createObjectStore(CONTACTS_IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function contactsCacheKey() {
        return `user:${userId || TEMP_USER_ID}`;
    }

    async function cacheContactsSnapshot(contacts) {
        try {
            const db = await openContactsIdb();
            const ownerId = userId || TEMP_USER_ID;
            await new Promise((resolve, reject) => {
                const tx = db.transaction(CONTACTS_IDB_STORE, 'readwrite');
                const store = tx.objectStore(CONTACTS_IDB_STORE);
                const payload = {
                    userId: ownerId,
                    contacts,
                    savedAt: Date.now(),
                };
                store.put(payload, contactsCacheKey());
                // Keep legacy key in sync for older builds, but always scoped to current user.
                store.put(payload, 'latest');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            db.close();
        } catch (e) {
            console.warn('Could not cache contacts offline:', e);
        }
    }

    async function loadCachedContactsSnapshot() {
        try {
            const db = await openContactsIdb();
            const ownerId = userId || TEMP_USER_ID;
            const record = await new Promise((resolve, reject) => {
                const tx = db.transaction(CONTACTS_IDB_STORE, 'readonly');
                const store = tx.objectStore(CONTACTS_IDB_STORE);
                const req = store.get(contactsCacheKey());
                req.onsuccess = () => {
                    if (req.result) {
                        resolve(req.result);
                        return;
                    }
                    // Fallback for older caches — only use if same signed-in user.
                    const legacy = store.get('latest');
                    legacy.onsuccess = () => resolve(legacy.result);
                    legacy.onerror = () => reject(legacy.error);
                };
                req.onerror = () => reject(req.error);
            });
            db.close();
            if (
                record
                && Array.isArray(record.contacts)
                && (record.userId === ownerId || (!record.userId && ownerId === TEMP_USER_ID))
            ) {
                return record.contacts;
            }
        } catch (e) {
            console.warn('Could not load cached contacts:', e);
        }
        return null;
    }

    function csvEscape(value) {
        const str = value == null ? '' : String(value);
        if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
        return str;
    }

    function exportContactsCsv(contacts) {
        const cols = ['name', 'title', 'company', 'department', 'industry', 'email', 'phone', 'website', 'address', 'notes', 'tags', 'followUpDate', 'dateAdded'];
        const rows = [cols.join(',')];
        contacts.forEach((c) => {
            rows.push(cols.map((key) => {
                if (key === 'tags') return csvEscape(Array.isArray(c.tags) ? c.tags.join('; ') : (c.tags || ''));
                return csvEscape(c[key] || '');
            }).join(','));
        });
        downloadBlob(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' }), 'folio-contacts.csv');
    }

    const scanTab = document.getElementById('scanTab');
    const contactsTab = document.getElementById('contactsTab');
    const networkTab = document.getElementById('networkTab');
    const scanContent = document.getElementById('scanContent');
    const contactsContent = document.getElementById('contactsContent');
    const networkContent = document.getElementById('networkContent');
    const signInModal = document.getElementById('signInModal');
    const signInForm = document.getElementById('signInForm');
    const signInError = document.getElementById('signInError');
    const signInTitle = document.getElementById('signInTitle');
    const signInSubmitLabel = document.getElementById('signInSubmitLabel');
    const signInModeToggle = document.getElementById('signInModeToggle');
    const googleSignInWrap = document.getElementById('googleSignInWrap');
    const googleSignInBtn = document.getElementById('googleSignInBtn');
    let signInIsRegister = false;
    let googleTokenClient = null;
    let googleSignInSetupPromise = null;
    const signOutBtn = document.getElementById('signOutBtn');
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    const networkGraph = document.getElementById('networkGraph');
    const clusterStats = document.getElementById('clusterStats');
    const topCompanies = document.getElementById('topCompanies');
    const uploadProgress = document.getElementById('uploadProgress');
    const thumbnailGallery = document.getElementById('thumbnailGallery');
    const scanCompleteMessage = document.getElementById('scanCompleteMessage');
    const goToContacts = document.getElementById('goToContacts');
    const editContactModal = document.getElementById('editContactModal');
    const editContactForm = document.getElementById('editContactForm');
    const editCardId = document.getElementById('editCardId');
    const editName = document.getElementById('editName');
    const editCompany = document.getElementById('editCompany');
    const editDepartment = document.getElementById('editDepartment');
    const editTitle = document.getElementById('editTitle');
    const editEmail = document.getElementById('editEmail');
    const editPhone = document.getElementById('editPhone');
    const editAddress = document.getElementById('editAddress');
    const editWebsite = document.getElementById('editWebsite');
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    const deleteAllModal = document.getElementById('deleteAllModal');
    const deleteAllBtn = document.getElementById('deleteAllBtn');
    const cancelDeleteAllBtn = document.getElementById('cancelDeleteAllBtn');
    const confirmDeleteAllBtn = document.getElementById('confirmDeleteAllBtn');
    // Chat elements
    const chatButton = document.getElementById('chatButton');
    const chatWindow = document.getElementById('chatWindow');
    const closeChat = document.getElementById('closeChat');
    const chatMessages = document.getElementById('chatMessages');
    const chatForm = document.getElementById('chatForm');
    const chatInput = document.getElementById('chatInput');

    // Chat state
    let chatHistory = [];
    const chatWelcome = document.getElementById('chatWelcome');
    const chatSendBtn = document.getElementById('chatSendBtn');

    function hideChatWelcome() {
        if (chatWelcome) chatWelcome.classList.add('is-hidden');
    }

    function addMessage(message, isUser = false) {
        hideChatWelcome();
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-row ${isUser ? 'chat-row--user' : 'chat-row--ai'}`;

        if (!isUser) {
            const avatar = document.createElement('div');
            avatar.className = 'chat-row__avatar';
            avatar.innerHTML = '<img src="assets/mascot-chat.svg" alt="">';
            messageDiv.appendChild(avatar);
        }

        const messageContent = document.createElement('div');
        messageContent.className = `chat-bubble ${isUser ? 'chat-bubble--user' : 'chat-bubble--ai'}`;

        if (!isUser) {
            messageContent.innerHTML = message.replace(/\n/g, '<br>');
        } else {
            messageContent.textContent = message;
        }
        messageDiv.appendChild(messageContent);
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        chatHistory.push({ message, isUser });
    }

    function showChat() {
        chatWindow.classList.remove('hidden');
        chatButton.classList.add('tab-active');
        [scanTab, contactsTab, networkTab].forEach(t => t.classList.remove('tab-active'));
        myCardBtn?.classList.remove('is-active');
        setNavCurrent(chatButton);
        if (typeof pulseNavIcon === 'function') pulseNavIcon(chatButton);
        chatInput.focus();

        if (chatHistory.length === 0 && chatWelcome) {
            chatWelcome.classList.remove('is-hidden');
            chatMessages.innerHTML = '';
        }
    }

    function hideChat() {
        chatWindow.classList.add('hidden');
        chatButton.classList.remove('tab-active');
        if (!scanContent.classList.contains('hidden')) {
            scanTab.classList.add('tab-active');
            setNavCurrent(scanTab);
        } else if (!contactsContent.classList.contains('hidden')) {
            contactsTab.classList.add('tab-active');
            setNavCurrent(contactsTab);
        } else if (!networkContent.classList.contains('hidden')) {
            networkTab.classList.add('tab-active');
            setNavCurrent(networkTab);
        } else if (myCardContent && !myCardContent.classList.contains('hidden')) {
            myCardBtn?.classList.add('is-active');
        }
    }

    async function handleChatMessage(message) {
        try {
            const typingDiv = document.createElement('div');
            typingDiv.id = 'aiTypingIndicator';
            typingDiv.className = 'chat-row chat-row--ai';
            typingDiv.innerHTML = `
                <div class="chat-row__avatar"><img src="assets/mascot-chat.svg" alt=""></div>
                <div class="chat-typing" aria-label="Folio is typing">
                    <span></span><span></span><span></span>
                </div>
            `;
            chatMessages.appendChild(typingDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;

            const response = await fetch(`${API_URL}/chat`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    message,
                    userId,
                    contacts: contactsData
                })
            });

            if (!response.ok) {
                const typingIndicator = document.getElementById('aiTypingIndicator');
                if (typingIndicator) typingIndicator.remove();
                throw new Error('Failed to get response from chat service');
            }

            const data = await response.json();
            const typingIndicator = document.getElementById('aiTypingIndicator');
            if (typingIndicator) typingIndicator.remove();
            addMessage(data.response);
        } catch (error) {
            const typingIndicator = document.getElementById('aiTypingIndicator');
            if (typingIndicator) typingIndicator.remove();
            console.error('Error handling chat message:', error);
            addMessage('I apologize, but I encountered an error processing your request. Please try again.');
        }
    }

    // Chat event listeners
    chatButton.addEventListener('click', showChat);
    closeChat.addEventListener('click', hideChat);

    document.querySelectorAll('.chat-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const prompt = chip.getAttribute('data-prompt');
            if (!prompt) return;
            chatInput.value = prompt;
            chatForm.requestSubmit();
        });
    });

    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const message = chatInput.value.trim();
        if (!message) return;

        if (chatSendBtn && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            chatSendBtn.classList.remove('is-sending');
            void chatSendBtn.offsetWidth;
            chatSendBtn.classList.add('is-sending');
            window.setTimeout(() => chatSendBtn.classList.remove('is-sending'), 560);
        }

        addMessage(message, true);
        chatInput.value = '';
        await handleChatMessage(message);
    });

    // Close chat on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !chatWindow.classList.contains('hidden')) {
            hideChat();
        }
    });

    // Debug: Log all critical elements
    console.log('DOM Elements:', {
        uploadProgress: uploadProgress,
        thumbnailGallery: thumbnailGallery,
        processingStatus: processingStatus
    });

    // Warn if processingStatus is missing but proceed
    if (!processingStatus) {
        console.warn('processingStatus element is missing; scan progress updates will be skipped.');
    }

    // Early return if uploadProgress or thumbnailGallery are missing (fatal)
    if (!uploadProgress || !thumbnailGallery) {
        console.error('Critical DOM elements are missing:', {
            uploadProgress: !!uploadProgress,
            thumbnailGallery: !!thumbnailGallery,
            processingStatus: !!processingStatus
        });
        return;
    }

    // Global variables
    let userId = null; // Store the Cognito userId (sub)

    // Toast notification function
    function showToast(message, type = 'error') {
        let toast = document.getElementById('toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast';
            document.body.appendChild(toast);
        }

        toast.style.background = type === 'success' ? 'var(--success)'
            : type === 'warning' ? 'var(--copper)'
            : 'var(--ink)';
        toast.style.color = type === 'warning' ? 'var(--ink)' : '#fff';
        toast.textContent = message;
        toast.classList.remove('hidden');

        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    function setUploadShimmer(active) {
        const shimmer = document.getElementById('uploadShimmer');
        const mascot = document.getElementById('scanMascot');
        const mascotLive = document.getElementById('scanMascotLive');
        if (shimmer) shimmer.classList.toggle('is-active', !!active);
        const src = active ? 'assets/mascot-scanning.svg' : 'assets/mascot-idle.svg';
        if (mascot) mascot.src = src;
        if (mascotLive) mascotLive.src = src;
    }

    function setScanProcessing(active, title, sub) {
        document.body.classList.toggle('scan-processing', !!active);
        const loader = document.getElementById('scanLoader');
        loader?.classList.toggle('hidden', !active);
        if (title) {
            const titleEl = document.getElementById('scanLoaderTitle');
            if (titleEl) titleEl.textContent = title;
        }
        if (sub) {
            const subEl = document.getElementById('scanLoaderSub');
            if (subEl) subEl.textContent = sub;
        }
        if (active) {
            document.body.classList.remove('camera-live');
        }
    }

    function celebrateScanSuccess() {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const burst = document.createElement('div');
        burst.className = 'celebration-burst';
        const colors = ['#c4a574', '#1b2a4a', '#e8ecf4', '#f3eadc', '#067647'];
        for (let i = 0; i < 18; i++) {
            const speck = document.createElement('span');
            speck.style.left = `${20 + Math.random() * 60}%`;
            speck.style.top = `${55 + Math.random() * 25}%`;
            speck.style.background = colors[i % colors.length];
            speck.style.animationDelay = `${Math.random() * 120}ms`;
            burst.appendChild(speck);
        }
        document.body.appendChild(burst);
        setTimeout(() => burst.remove(), 1000);
        const mascot = document.getElementById('scanMascot');
        const mascotLive = document.getElementById('scanMascotLive');
        if (mascot) mascot.src = 'assets/mascot-success.svg';
        if (mascotLive) mascotLive.src = 'assets/mascot-success.svg';
    }

    // Authentication Functions
    function readAuthCookie() {
        try {
            const parts = (document.cookie || '').split(';');
            for (let i = 0; i < parts.length; i += 1) {
                const [name, ...rest] = parts[i].trim().split('=');
                if (name === AUTH_COOKIE_KEY) {
                    return decodeURIComponent(rest.join('=') || '');
                }
            }
        } catch (e) { /* ignore */ }
        return '';
    }

    function writeAuthCookie(token) {
        try {
            const secure = window.location.protocol === 'https:' ? '; Secure' : '';
            if (token) {
                document.cookie = `${AUTH_COOKIE_KEY}=${encodeURIComponent(token)}; Path=/; Max-Age=${AUTH_MAX_AGE}; SameSite=Lax${secure}`;
            } else {
                document.cookie = `${AUTH_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
            }
        } catch (e) { /* ignore */ }
    }

    function getAuthToken() {
        try {
            const stored = localStorage.getItem(AUTH_TOKEN_KEY) || '';
            if (stored) return stored;
        } catch (e) { /* ignore */ }
        return readAuthCookie();
    }

    function setAuthToken(token) {
        try {
            if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
            else localStorage.removeItem(AUTH_TOKEN_KEY);
        } catch (e) { /* ignore */ }
        writeAuthCookie(token || '');
    }

    function readCachedAuthUser() {
        try {
            const raw = localStorage.getItem(AUTH_USER_CACHE_KEY);
            if (!raw) return null;
            const user = JSON.parse(raw);
            return user && user.id ? user : null;
        } catch (e) {
            return null;
        }
    }

    function cacheAuthUser(user) {
        try {
            if (user?.id) localStorage.setItem(AUTH_USER_CACHE_KEY, JSON.stringify(user));
            else localStorage.removeItem(AUTH_USER_CACHE_KEY);
        } catch (e) { /* ignore */ }
    }

    function hasStoredSessionHint() {
        return Boolean(getAuthToken() || readCachedAuthUser()?.id);
    }

    function setBootStatus(message) {
        const sub = document.getElementById('folioBootSub');
        if (sub && message) sub.textContent = message;
    }

    function showAuthLoading(title, subtitle) {
        const overlay = document.getElementById('authLoadingOverlay');
        const titleEl = document.getElementById('authLoadingTitle');
        const subEl = document.getElementById('authLoadingSub');
        if (titleEl && title) titleEl.textContent = title;
        if (subEl && subtitle) subEl.textContent = subtitle;
        overlay?.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function hideAuthLoading() {
        document.getElementById('authLoadingOverlay')?.classList.add('hidden');
        if (signInModal?.classList.contains('hidden')) {
            document.body.style.overflow = '';
        }
    }

    function authHeaders(extra) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
        const token = getAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    function applyAuthUser(user, token) {
        if (token) setAuthToken(token);
        userId = user?.id || null;
        window.userId = userId;
        if (user?.id) cacheAuthUser(user);
        if (userId) signOutBtn?.classList.remove('hidden');
    }

    function clearAuthSession() {
        setAuthToken('');
        cacheAuthUser(null);
        userId = null;
        window.userId = null;
        contactsData = [];
        signOutBtn?.classList.add('hidden');
    }

    async function fetchAuthMe(useBearer) {
        const headers = useBearer
            ? authHeaders()
            : { 'Content-Type': 'application/json' };
        return fetch(`${API_URL}/auth/me`, {
            headers,
            credentials: 'include',
        });
    }

    async function isAuthenticated() {
        if (authCheckPromise) return authCheckPromise;
        authCheckPromise = (async () => {
            try {
                let response = await fetchAuthMe(true);
                // Stale local Bearer can shadow a valid HttpOnly cookie — retry cookie-only.
                if (response.status === 401 && getAuthToken()) {
                    setAuthToken('');
                    response = await fetchAuthMe(false);
                }
                if (!response.ok) {
                    if (response.status === 401) clearAuthSession();
                    return false;
                }
                const data = await response.json();
                applyAuthUser(data.user, data.token);
                return Boolean(data.user?.id);
            } catch (err) {
                console.warn('Auth check failed', err);
                // Offline / cold-start: keep cached session so refresh doesn't force login.
                const cached = readCachedAuthUser();
                const token = getAuthToken();
                if (cached?.id && token) {
                    applyAuthUser(cached, token);
                    return true;
                }
                return Boolean(token);
            } finally {
                authCheckPromise = null;
            }
        })();
        return authCheckPromise;
    }

    function setSignInMode(isRegister) {
        signInIsRegister = Boolean(isRegister);
        if (signInTitle) signInTitle.textContent = signInIsRegister ? 'Create account' : 'Sign in';
        if (signInSubmitLabel) signInSubmitLabel.textContent = signInIsRegister ? 'Create account' : 'Continue';
        if (signInModeToggle) {
            signInModeToggle.textContent = signInIsRegister
                ? 'Already have an account? Sign in'
                : 'Need an account? Create one';
        }
        signInError?.classList.add('hidden');
    }

    function showSignInModal() {
        setSignInMode(false);
        hideAuthLoading();
        signInModal.classList.remove('hidden');
        signInError.classList.add('hidden');
        setupGoogleSignIn();
    }

    function hideSignInModal() {
        signInModal.classList.add('hidden');
    }

    function finishAuthenticatedSession(user, token, toastMsg) {
        applyAuthUser(user, token);
        hideAuthLoading();
        hideSignInModal();
        switchToTab('scan');
        loadContacts().catch((error) => {
            console.error('Error loading contacts in background:', error);
            showToast('Error loading contacts after sign in', 'error');
        });
        if (toastMsg) showToast(toastMsg, 'success');
    }

    function loadGoogleIdentityScript() {
        if (window.google?.accounts?.oauth2) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-folio-gsi="1"]');
            if (existing) {
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => reject(new Error('Failed to load Google')), { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.dataset.folioGsi = '1';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load Google'));
            document.head.appendChild(script);
        });
    }

    function showSignInError(message) {
        if (!signInError) return;
        signInError.textContent = message;
        signInError.classList.remove('hidden');
    }

    async function completeGoogleSignIn(payload) {
        showAuthLoading('Signing you in…', 'Connecting your Google account. This can take a few seconds.');
        try {
            const response = await fetch(`${API_URL}/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Google sign-in failed');
            }
            finishAuthenticatedSession(data.user, data.token, 'Signed in with Google');
        } catch (error) {
            hideAuthLoading();
            throw error;
        }
    }

    async function setupGoogleSignIn() {
        if (googleSignInSetupPromise) return googleSignInSetupPromise;
        googleSignInSetupPromise = (async () => {
            if (!googleSignInWrap || !googleSignInBtn) return;
            const response = await fetch(`${API_URL}/auth/config`);
            const config = await response.json().catch(() => ({}));
            const clientId = (config.googleClientId || '').trim();
            if (!clientId) {
                googleSignInWrap.classList.add('hidden');
                return;
            }
            await loadGoogleIdentityScript();
            if (!window.google?.accounts?.oauth2) {
                throw new Error('Google sign-in is unavailable');
            }
            googleTokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: 'openid email profile',
                callback: async (tokenResponse) => {
                    googleSignInBtn.disabled = false;
                    if (tokenResponse.error) {
                        hideAuthLoading();
                        if (tokenResponse.error === 'popup_closed_by_user' || tokenResponse.error === 'access_denied') {
                            return;
                        }
                        showSignInError('Google sign-in failed');
                        return;
                    }
                    try {
                        await completeGoogleSignIn({ accessToken: tokenResponse.access_token });
                    } catch (error) {
                        console.error('Google sign-in error', error);
                        hideAuthLoading();
                        showSignInError(error.message || 'Google sign-in failed');
                    }
                },
                error_callback: (error) => {
                    googleSignInBtn.disabled = false;
                    hideAuthLoading();
                    const type = error?.type || error?.message || '';
                    if (String(type).includes('popup_closed') || String(type).includes('popup_closed_by_user')) {
                        return;
                    }
                    showSignInError('Google sign-in failed');
                },
            });
            if (!googleSignInBtn.dataset.bound) {
                googleSignInBtn.dataset.bound = '1';
                googleSignInBtn.addEventListener('click', () => {
                    signInError?.classList.add('hidden');
                    if (!googleTokenClient) {
                        showSignInError('Google sign-in is not ready yet');
                        return;
                    }
                    googleSignInBtn.disabled = true;
                    showAuthLoading('Opening Google…', 'Choose your account, then we\'ll finish signing you in.');
                    googleTokenClient.requestAccessToken({ prompt: 'select_account' });
                    window.setTimeout(() => {
                        googleSignInBtn.disabled = false;
                    }, 8000);
                });
            }
            googleSignInWrap.classList.remove('hidden');
        })().catch((error) => {
            console.warn('Google sign-in unavailable', error);
            googleSignInSetupPromise = null;
            googleSignInWrap?.classList.add('hidden');
        });
        return googleSignInSetupPromise;
    }

    function setNavCurrent(activeBtn) {
        [scanTab, contactsTab, networkTab, chatButton].forEach((t) => {
            if (!t) return;
            if (t === activeBtn) t.setAttribute('aria-current', 'page');
            else t.removeAttribute('aria-current');
        });
    }

    function pulseNavIcon(button) {
        if (!button || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        button.classList.remove('nav-tap');
        // Force reflow so the animation can restart on repeated clicks
        void button.offsetWidth;
        button.classList.add('nav-tap');
        const icon = button.querySelector('.pill-nav__icon');
        if (icon) {
            icon.classList.remove('nav-icon-bounce');
            void icon.offsetWidth;
            icon.classList.add('nav-icon-bounce');
        }
        window.clearTimeout(button._navTapTimer);
        button._navTapTimer = window.setTimeout(() => {
            button.classList.remove('nav-tap');
            if (icon) icon.classList.remove('nav-icon-bounce');
        }, 700);
    }

    // Tab Switching with Authentication
    async function switchToTab(tab) {
        // Trust in-memory session; only hit the network when we have no user yet.
        const authenticated = userId ? true : await isAuthenticated();
        if (authenticated) {
            hideChat();
            closeContactDetail();
            document.body.classList.remove('is-public-card');
            // First, update UI immediately to show the selected tab content
            [scanTab, contactsTab, networkTab].forEach(t => t.classList.remove('tab-active'));
            myCardBtn?.classList.remove('is-active');
            [scanContent, contactsContent, networkContent, myCardContent, publicCardContent].forEach(c => {
                if (!c) return;
                c.classList.add('hidden');
                c.classList.remove('fade-in');
            });
            
            // Show the selected tab content immediately
            if (tab === 'scan') {
                scanTab.classList.add('tab-active');
                pulseNavIcon(scanTab);
                setNavCurrent(scanTab);
                scanContent.classList.remove('hidden');
                scanContent.classList.add('fade-in');
                
                // Show a loading placeholder if needed
                if (thumbnailGallery && thumbnailGallery.children.length === 0) {
                    thumbnailGallery.innerHTML = '';
                }
            } else if (tab === 'contacts') {
                contactsTab.classList.add('tab-active');
                pulseNavIcon(contactsTab);
                setNavCurrent(contactsTab);
                contactsContent.classList.remove('hidden');
                contactsContent.classList.add('fade-in');
                
                // Show loading state if no contacts are loaded yet
                if (contactsData.length === 0) {
                    showContactsLoading(
                        'Restoring your cards…',
                        'Fetching saved contacts from your account.'
                    );
                } else {
                    // Apply current filters to existing data
                    filterAndSortContacts();
                }
            } else if (tab === 'network') {
                networkTab.classList.add('tab-active');
                pulseNavIcon(networkTab);
                setNavCurrent(networkTab);
                networkContent.classList.remove('hidden');
                networkContent.classList.add('fade-in');
                
                // Always refresh network visualizations when switching to the network tab
                if (contactsData.length > 0) {
                    updateNetworkVisualization();
                    updateNetworkAnalytics();
                } else {
                    // Show loading state in network visualization area if needed
                    networkGraph.innerHTML = '<div class="empty-state" style="box-shadow:none;background:transparent;"><p>Loading network…</p></div>';
                }
            } else if (tab === 'mycard') {
                myCardBtn?.classList.add('is-active');
                setNavCurrent(null);
                if (myCardContent) {
                    myCardContent.classList.remove('hidden');
                    myCardContent.classList.add('fade-in');
                }
                if (typeof hydrateMyCardStudio === 'function') hydrateMyCardStudio();
            }
            
            // Then, load data asynchronously if needed
            if (contactsData.length === 0) {
                // Start loading contacts in the background
                loadContacts().then(() => {
                    // After contacts are loaded, update the current tab's content
                    if (tab === 'contacts') {
                        filterAndSortContacts();
                    } else if (tab === 'network') {
                        updateNetworkVisualization();
                        updateNetworkAnalytics();
                    }
                }).catch(error => {
                    console.error('Error loading contacts:', error);
                    // Show error state in the current tab
                    if (tab === 'contacts' && contactsList) {
                        contactsList.innerHTML = '<div class="text-center py-8 text-red-600"><p>Failed to load contacts. Please try again.</p></div>';
                    } else if (tab === 'network' && networkGraph) {
                        networkGraph.innerHTML = '<div class="text-center py-8 text-red-600"><p>Failed to load network data. Please try again.</p></div>';
                    }
                });
            }
        } else {
            showSignInModal();
        }
    }

    // Event Listeners for Tabs
    scanTab.addEventListener('click', () => switchToTab('scan'));
    contactsTab.addEventListener('click', () => switchToTab('contacts'));
    networkTab.addEventListener('click', () => switchToTab('network'));
    goToContacts.addEventListener('click', (e) => {
        e.preventDefault();
        switchToTab('contacts');
    });

    // Search and Sort Functionality
    searchContacts.addEventListener('input', () => {
        filterAndSortContacts();
    });

    filterByIndustry.addEventListener('change', () => {
        filterAndSortContacts();
    });

    if (filterByTag) {
        filterByTag.addEventListener('change', () => {
            filterAndSortContacts();
        });
    }

    if (filterFollowUp) {
        filterFollowUp.addEventListener('change', () => {
            filterAndSortContacts();
        });
    }

    sortContacts.addEventListener('change', () => {
        filterAndSortContacts();
    });

    function updateTagFilterOptions() {
        if (!filterByTag) return;
        const uniqueTags = new Set();
        contactsData.forEach((c) => {
            (Array.isArray(c.tags) ? c.tags : parseTagsInput(c.tags)).forEach((tag) => uniqueTags.add(tag));
        });
        const currentValue = filterByTag.value;
        while (filterByTag.options.length > 1) {
            filterByTag.remove(1);
        }
        Array.from(uniqueTags).sort((a, b) => a.localeCompare(b)).forEach((tag) => {
            const option = document.createElement('option');
            option.value = tag;
            option.textContent = tag;
            filterByTag.appendChild(option);
        });
        if (currentValue && uniqueTags.has(currentValue)) {
            filterByTag.value = currentValue;
        }
    }

    function updateFollowUpHint() {
        if (!followUpHint) return;
        const overdueCount = contactsData.filter((c) => getFollowUpStatus(c.followUpDate) === 'overdue').length;
        if (overdueCount > 0) {
            followUpHint.textContent = `${overdueCount} follow-up${overdueCount === 1 ? '' : 's'} overdue`;
            followUpHint.classList.remove('hidden');
        } else {
            followUpHint.textContent = '';
            followUpHint.classList.add('hidden');
        }
    }

    function filterAndSortContacts() {
        if (!contactsData || !Array.isArray(contactsData)) {
            console.error('No valid contacts data available for filtering/sorting');
                return;
            }

        const searchTerm = searchContacts.value.toLowerCase();
        const sortValue = sortContacts.value;
        const selectedIndustry = filterByIndustry.value;
        const selectedTag = filterByTag ? filterByTag.value : '';
        const selectedFollowUp = filterFollowUp ? filterFollowUp.value : '';
        
        // Filter contacts based on search term and industry using the locally stored contactsData
        let filteredContacts = contactsData.filter(contact => {
            // Check if contact has all required fields
            if (!contact) return false;
            
            // Check industry filter
            if (selectedIndustry && contact.industry !== selectedIndustry) {
                return false;
            }

            const tags = Array.isArray(contact.tags) ? contact.tags : parseTagsInput(contact.tags);
            if (selectedTag && !tags.includes(selectedTag)) {
                return false;
            }

            if (selectedFollowUp) {
                const status = getFollowUpStatus(contact.followUpDate);
                if (selectedFollowUp === 'hasReminder' && !contact.followUpDate) return false;
                if (selectedFollowUp === 'overdue' && status !== 'overdue') return false;
                if (selectedFollowUp === 'dueSoon' && status !== 'dueSoon') return false;
            }
            
            // Search across all text fields
            const tagHaystack = tags.join(' ').toLowerCase();
            return (
                (contact.name && contact.name.toLowerCase().includes(searchTerm)) ||
                (contact.company && contact.company.toLowerCase().includes(searchTerm)) ||
                (contact.title && contact.title.toLowerCase().includes(searchTerm)) ||
                (contact.email && contact.email.toLowerCase().includes(searchTerm)) ||
                (contact.phone && contact.phone.toLowerCase().includes(searchTerm)) ||
                (contact.address && contact.address.toLowerCase().includes(searchTerm)) ||
                (contact.website && contact.website.toLowerCase().includes(searchTerm)) ||
                (contact.industry && contact.industry.toLowerCase().includes(searchTerm)) ||
                (contact.notes && contact.notes.toLowerCase().includes(searchTerm)) ||
                tagHaystack.includes(searchTerm)
            );
        });
        
        // Sort filtered contacts
        filteredContacts.sort((a, b) => {
            switch (sortValue) {
                case 'nameAsc':
                    return (a.name || '').localeCompare(b.name || '');
                case 'nameDesc':
                    return (b.name || '').localeCompare(a.name || '');
                case 'companyAsc':
                    return (a.company || '').localeCompare(b.company || '');
                case 'companyDesc':
                    return (b.company || '').localeCompare(a.company || '');
                case 'dateDesc':
                    return new Date(b.dateAdded || 0) - new Date(a.dateAdded || 0);
                case 'dateAsc':
                    return new Date(a.dateAdded || 0) - new Date(b.dateAdded || 0);
                default:
                    return 0;
            }
        });

        updateFollowUpHint();
        
        // Update the UI with filtered and sorted contacts
        updateContactsList(filteredContacts);
    }

    // Helper function to escape HTML special characters
    function escapeHtml(unsafe) {
        if (unsafe === null || unsafe === undefined) return '';
        return unsafe
            .toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function normalizeSavedCard(contact) {
        if (!contact) return contact;
        scrubSideLabelsFromContact(contact);
        const front = contact.frontImage || contact.originalImageUrl || contact.cachedImageUrl || contact.imageUrl || '';
        const back = contact.backImage || contact.originalBackImageUrl || contact.backImageUrl || '';
        contact.frontImage = front;
        contact.backImage = back;
        contact.originalImageUrl = contact.originalImageUrl || front;
        contact.originalBackImageUrl = contact.originalBackImageUrl || back;
        contact.jobTitle = contact.jobTitle || contact.title || '';
        contact.title = contact.title || contact.jobTitle || '';
        contact.createdAt = contact.createdAt || contact.dateAdded || '';
        contact.dateAdded = contact.dateAdded || contact.createdAt || '';
        contact.updatedAt = contact.updatedAt || '';
        return contact;
    }

    function cardPreviewSrc(contact) {
        return contact.cachedImageUrl || contact.frontImage || contact.originalImageUrl || contact.imageUrl || '';
    }

    function formatSavedAgo(iso) {
        if (!iso) return '';
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return '';
        const days = Math.round((Date.now() - then) / 86400000);
        if (days <= 0) return 'Saved today';
        if (days === 1) return 'Saved yesterday';
        if (days < 21) return `Saved ${days} days ago`;
        return `Saved ${new Date(iso).toLocaleDateString()}`;
    }

    function showContactsLoading(title, subtitle) {
        const titleEl = contactsLoading?.querySelector('.contacts-loading__title');
        const subEl = contactsLoading?.querySelector('.contacts-loading__sub');
        if (titleEl && title) titleEl.textContent = title;
        if (subEl && subtitle) subEl.textContent = subtitle;
        contactsLoading?.classList.remove('hidden');
        noContacts?.classList.add('hidden');
        if (contactsList && contactsData.length === 0) {
            contactsList.innerHTML = '';
        }
    }

    function hideContactsLoading() {
        contactsLoading?.classList.add('hidden');
    }

    function updateContactsList(contacts) {
        if (!contactsList) return;

        if (isLoadingContacts && contacts.length === 0) {
            contactsList.innerHTML = '';
            noContacts?.classList.add('hidden');
            contactsLoading?.classList.remove('hidden');
            return;
        }

        hideContactsLoading();

        if (contacts.length === 0) {
            contactsList.innerHTML = '';
            noContacts.classList.remove('hidden');
            return;
        }

        noContacts.classList.add('hidden');
        contactsList.innerHTML = contacts.map((raw) => {
            const contact = normalizeSavedCard({ ...raw });
            const preview = cardPreviewSrc(contact);
            const role = [contact.title, contact.company].filter(Boolean).join(' · ');
            const initial = (contact.name || contact.company || 'C').trim().charAt(0).toUpperCase();
            return `
                <article class="saved-card" data-card-id="${contact.cardId}" role="button" tabindex="0">
                    <div class="saved-card__preview">
                        ${preview
                            ? `<img src="${preview}" alt="" loading="lazy">`
                            : `<div class="saved-card__preview-fallback">${escapeHtml(initial)}</div>`}
                    </div>
                    <div class="saved-card__body">
                        <div class="saved-card__row">
                            <div>
                                <h3>${escapeHtml(contact.name || 'Unnamed contact')}</h3>
                                ${role ? `<p class="saved-card__meta">${escapeHtml(role)}</p>` : ''}
                                <p class="saved-card__when">${escapeHtml(formatSavedAgo(contact.createdAt || contact.dateAdded))}${(contact.sides > 1 || contact.backImage) ? ' · Front & back' : ''}</p>
                            </div>
                            <button type="button" class="saved-card__menu" data-edit="${contact.cardId}" aria-label="Edit card">•••</button>
                        </div>
                    </div>
                </article>
            `;
        }).join('');

        contactsList.querySelectorAll('.saved-card').forEach((card) => {
            const open = () => {
                const contact = contactsData.find((c) => c.cardId === card.dataset.cardId);
                if (contact) openContactDetail(contact);
            };
            card.addEventListener('click', open);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                }
            });
        });
        contactsList.querySelectorAll('.saved-card__menu').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const contact = contactsData.find((c) => c.cardId === btn.dataset.edit);
                if (contact) showEditContactModal(contact);
            });
        });
    }

    let pendingReviewContact = null;
    let activeDetailContact = null;
    let detailShowingBack = false;
    let closingDetailFromPop = false;

    function closeScanReview() {
        const review = document.getElementById('scanReview');
        if (!review) return;
        review.classList.add('hidden');
        review.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('scan-review-open');
        pendingReviewContact = null;
    }

    function openScanReview(contact) {
        const review = document.getElementById('scanReview');
        if (!review || !contact) return;
        pendingReviewContact = normalizeSavedCard(contact);
        const front = pendingReviewContact.frontImage || pendingReviewContact.originalImageUrl || '';
        const back = pendingReviewContact.backImage || pendingReviewContact.originalBackImageUrl || '';
        const frontImg = document.getElementById('scanReviewFront');
        const backImg = document.getElementById('scanReviewBack');
        const backWrap = document.getElementById('scanReviewBackWrap');
        if (frontImg) frontImg.src = front;
        if (back) {
            if (backImg) backImg.src = back;
            backWrap?.classList.remove('hidden');
        } else {
            backWrap?.classList.add('hidden');
        }
        const status = document.getElementById('scanReviewStatus');
        if (status) {
            status.textContent = pendingReviewContact.name
                ? 'Review the cropped card, then save it to your network.'
                : 'We could not read every field. Edit the details before saving.';
        }
        const fields = document.getElementById('scanReviewFields');
        if (fields) fields.innerHTML = renderDetailSections(pendingReviewContact);
        review.classList.remove('hidden');
        review.setAttribute('aria-hidden', 'false');
        document.body.classList.add('scan-review-open');
    }

    document.getElementById('scanReviewClose')?.addEventListener('click', () => {
        closeScanReview();
        switchToTab('contacts');
    });
    document.getElementById('scanReviewEdit')?.addEventListener('click', () => {
        if (pendingReviewContact) showEditContactModal(pendingReviewContact);
    });
    document.getElementById('scanReviewSave')?.addEventListener('click', () => {
        closeScanReview();
        switchToTab('contacts');
        showToast('Card saved', 'success');
    });

    function closeContactDetail(fromPop) {
        const view = document.getElementById('contactDetailView');
        if (!view) return;
        closeCardPhotoLightbox();
        view.classList.add('hidden');
        view.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('contact-detail-open');
        activeDetailContact = null;
        detailShowingBack = false;
        document.getElementById('contactDetailFlipCard')?.classList.remove('is-flipped');
        if (!fromPop && history.state && history.state.folioCard) {
            closingDetailFromPop = true;
            history.back();
        }
    }

    function iconMarkup(name) {
        const icons = {
            phone: '<path d="M6 4h3l1.5 4-2 1.5a12 12 0 006 6L16.5 14l4 1.5V19a2 2 0 01-2 2A15 15 0 014 6a2 2 0 012-2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
            mail: '<path d="M4 6h16v12H4V6zm0 0l8 7 8-7" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
            web: '<path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 0c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9zM3 12h18" stroke="currentColor" stroke-width="1.7"/>',
            pin: '<path d="M12 21s7-6.1 7-11a7 7 0 10-14 0c0 4.9 7 11 7 11z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="10" r="2.2" stroke="currentColor" stroke-width="1.7"/>',
            note: '<path d="M7 5h10v14H7zM9 9h6M9 13h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
        };
        return `<svg viewBox="0 0 24 24" fill="none" width="18" height="18">${icons[name] || ''}</svg>`;
    }

    async function vcardForContact(contact) {
        // Always build from the (possibly edited) payload so Save-to-Phone edits are included.
        if (contact && (contact._phoneSaveDraft || !contact.cardId)) {
            return buildVCard(contact);
        }
        try {
            const response = await fetch(`${API_URL}/vcard/${contact.cardId}?userId=${encodeURIComponent(userId)}`, {
                headers: authHeaders(),
                credentials: 'include',
            });
            if (response.ok) return await response.text();
        } catch (e) { /* local */ }
        return buildVCard(contact);
    }

    function isAndroidDeviceUa() {
        return /Android/i.test(navigator.userAgent || '');
    }

    function isIosDeviceUa() {
        return /iPhone|iPad|iPod/i.test(navigator.userAgent || '')
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function androidInsertContactIntent(contact) {
        // Chrome Android intent format (must use intent://host/#Intent;...;end)
        // See: https://developer.chrome.com/docs/android/intents
        const extras = [];
        const add = (key, value) => {
            const text = String(value || '').trim();
            if (!text) return;
            extras.push(`S.${key}=${encodeURIComponent(text)}`);
        };
        add('name', contact.name);
        add('phone', firstPhoneNumber(contact.phone) || phoneNumbers(contact.phone)[0] || '');
        add('email', contact.email);
        add('company', contact.company);
        add('job_title', contact.title);
        add('postal', contact.address);

        const extraStr = extras.length ? `${extras.join(';')};` : '';
        return [
            // Preferred: RawContacts insert (opens native Add Contact form)
            `intent://vnd.android.cursor.dir/raw_contact/#Intent;action=android.intent.action.INSERT;${extraStr}end`,
            // Fallback MIME host
            `intent://vnd.android.cursor.dir/contact/#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/contact;${extraStr}end`,
        ];
    }

    function rememberPhoneSaveReturn(contact) {
        try {
            const cardId = contact?.cardId || phoneSaveSourceContact?.cardId || activeDetailContact?.cardId;
            if (!cardId) return;
            sessionStorage.setItem('folio_phone_save_return', JSON.stringify({
                cardId,
                at: Date.now(),
            }));
        } catch (e) { /* ignore */ }
    }

    function peekPhoneSaveReturn() {
        try {
            const raw = sessionStorage.getItem('folio_phone_save_return');
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data?.cardId || Date.now() - (data.at || 0) > 30 * 60 * 1000) {
                sessionStorage.removeItem('folio_phone_save_return');
                return null;
            }
            return data;
        } catch (e) {
            return null;
        }
    }

    function clearPhoneSaveReturn() {
        try { sessionStorage.removeItem('folio_phone_save_return'); } catch (e) { /* ignore */ }
    }

    async function restoreContactAfterPhoneSave() {
        const data = peekPhoneSaveReturn();
        if (!data?.cardId) return false;
        clearPhoneSaveReturn();
        closeSaveToPhoneModal();
        try {
            if (typeof switchToTab === 'function') await switchToTab('contacts');
        } catch (e) { /* ignore */ }
        const contact = contactsData.find((c) => c.cardId === data.cardId);
        if (contact) {
            openContactDetail(contact);
            return true;
        }
        return false;
    }

    function launchAndroidUrl(url) {
        // Use a hidden iframe so Chrome does NOT navigate this tab away from the card page.
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        iframe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;left:0;top:0;';
        document.body.appendChild(iframe);
        try {
            iframe.src = url;
        } catch (err) {
            console.warn('iframe intent failed', err);
        }
        setTimeout(() => {
            try { iframe.remove(); } catch (e) { /* ignore */ }
        }, 2500);

        // Also poke via a link that does not replace this document (no target=_self navigation).
        try {
            const link = document.createElement('a');
            link.href = url;
            link.rel = 'noopener';
            link.target = '_blank';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (err) {
            console.warn('anchor intent failed', err);
        }
    }

    async function openVCardInContactsApp(vcardContent, filename) {
        const blob = new Blob([vcardContent], { type: 'text/vcard;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        // Android: never navigate this tab — share sheet keeps you on the card page.
        if (isAndroidDeviceUa() || !isIosDeviceUa()) {
            try {
                const file = new File([blob], filename, { type: 'text/vcard' });
                if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
                    await navigator.share({
                        files: [file],
                        title: filename.replace(/\.vcf$/i, '') || 'Contact',
                        text: 'Save this contact',
                    });
                    URL.revokeObjectURL(url);
                    return 'shared';
                }
            } catch (err) {
                if (err && err.name === 'AbortError') {
                    URL.revokeObjectURL(url);
                    return 'aborted';
                }
            }
            URL.revokeObjectURL(url);
            return 'failed';
        }

        // iOS: opening the vCard leaves the page — remember card so we can restore on return.
        rememberPhoneSaveReturn(activeDetailContact || phoneSaveSourceContact);
        ignoreDetailPopUntil = Date.now() + 8000;
        window.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 20000);
        return 'opened';
    }

    async function saveContactToDevice(contact) {
        const filename = `${(contact.name || 'contact').replace(/[^\w.-]+/g, '_') || 'contact'}.vcf`;
        const vcardContent = buildVCard(contact);

        rememberPhoneSaveReturn(contact);
        ignoreDetailPopUntil = Date.now() + 8000;

        // Android: fire Chrome intent without navigating away from card detail.
        if (isAndroidDeviceUa()) {
            const intents = androidInsertContactIntent(contact);
            try {
                launchAndroidUrl(intents[0]);
                return 'opened';
            } catch (err) {
                console.warn('Android insert intent failed', err);
                try {
                    launchAndroidUrl(intents[1]);
                    return 'opened';
                } catch (err2) {
                    console.warn('Android fallback intent failed', err2);
                }
                return openVCardInContactsApp(vcardContent, filename);
            }
        }

        if (isIosDeviceUa()) {
            return openVCardInContactsApp(vcardContent, filename);
        }

        const blob = new Blob([vcardContent], { type: 'text/vcard;charset=utf-8' });
        downloadBlob(blob, filename);
        clearPhoneSaveReturn();
        return 'downloaded';
    }

    async function shareContactToAndroidContacts(contact) {
        const filename = `${(contact.name || 'contact').replace(/[^\w.-]+/g, '_') || 'contact'}.vcf`;
        rememberPhoneSaveReturn(contact);
        ignoreDetailPopUntil = Date.now() + 8000;
        return openVCardInContactsApp(buildVCard(contact), filename);
    }

    function openSaveToPhoneModal(contact) {
        phoneSaveSourceContact = contact;
        const modal = document.getElementById('saveToPhoneModal');
        if (!modal) return;

        // Keep the card detail page open underneath — never dismiss it for this sheet.
        if (contact?.cardId) {
            activeDetailContact = contact;
            const view = document.getElementById('contactDetailView');
            if (view?.classList.contains('hidden')) {
                openContactDetail(contact);
            } else {
                document.body.classList.add('contact-detail-open');
                view?.setAttribute('aria-hidden', 'false');
            }
        }

        document.getElementById('savePhoneName').value = contact.name || '';
        document.getElementById('savePhoneNumber').value = phoneNumbers(contact.phone)[0] || contact.phone || '';
        document.getElementById('savePhoneEmail').value = contact.email || '';
        document.getElementById('savePhoneTitle').value = contact.title || '';
        document.getElementById('savePhoneCompany').value = contact.company || '';
        document.getElementById('savePhoneAddress').value = contact.address || '';
        const hint = document.getElementById('saveToPhoneHint');
        const fallbackBtn = document.getElementById('saveToPhoneShareFallback');
        if (fallbackBtn) {
            fallbackBtn.classList.toggle('hidden', !(isAndroidDeviceUa() || isIosDeviceUa()));
        }
        if (hint) {
            hint.textContent = isAndroidDeviceUa()
                ? 'Opens Android Add Contact with these details. If nothing opens, use “Share to Contacts” and pick Contacts.'
                : isIosDeviceUa()
                    ? 'This opens Add Contact on your iPhone with these details filled in.'
                    : 'On desktop this downloads a contact file you can import.';
        }
        modal.classList.remove('hidden');
        document.body.classList.add('save-to-phone-open');
        document.body.style.overflow = 'hidden';
        // Delay focus so iOS doesn’t scroll the collection page underneath.
        window.setTimeout(() => {
            document.getElementById('savePhoneName')?.focus({ preventScroll: true });
        }, 50);
    }

    function closeSaveToPhoneModal() {
        document.getElementById('saveToPhoneModal')?.classList.add('hidden');
        phoneSaveSourceContact = null;
        document.body.classList.remove('save-to-phone-open');
        // Keep overflow locked if card detail is still open.
        if (document.body.classList.contains('contact-detail-open')) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
    }

    function readSaveToPhoneDraft() {
        return {
            ...(phoneSaveSourceContact || {}),
            name: document.getElementById('savePhoneName')?.value.trim() || '',
            phone: document.getElementById('savePhoneNumber')?.value.trim() || '',
            email: document.getElementById('savePhoneEmail')?.value.trim() || '',
            title: document.getElementById('savePhoneTitle')?.value.trim() || '',
            company: document.getElementById('savePhoneCompany')?.value.trim() || '',
            address: document.getElementById('savePhoneAddress')?.value.trim() || '',
            _phoneSaveDraft: true,
        };
    }

    function renderDetailSections(contact) {
        const blocks = [];
        const contactRows = [
            contact.phone ? `<a class="detail-row" href="tel:${escapeHtml(firstPhoneNumber(contact.phone))}"><span>${iconMarkup('phone')}</span><strong>${escapeHtml(contact.phone)}</strong></a>` : '',
            contact.email ? `<a class="detail-row" href="mailto:${escapeHtml(contact.email)}"><span>${iconMarkup('mail')}</span><strong>${escapeHtml(contact.email)}</strong></a>` : '',
            contact.website ? `<a class="detail-row" href="${escapeHtml(normalizeHref(contact.website))}" target="_blank" rel="noopener"><span>${iconMarkup('web')}</span><strong>${escapeHtml(contact.website)}</strong></a>` : '',
        ].filter(Boolean);
        if (contactRows.length) blocks.push(`<section class="detail-block"><h4>Contact</h4>${contactRows.join('')}</section>`);
        if (contact.address) {
            blocks.push(`<section class="detail-block"><h4>Address</h4><a class="detail-row" href="https://maps.google.com/?q=${encodeURIComponent(contact.address)}" target="_blank" rel="noopener"><span>${iconMarkup('pin')}</span><strong>${escapeHtml(contact.address)}</strong></a></section>`);
        }
        const socialRows = ['linkedin', 'instagram', 'twitter', 'github']
            .map((key) => contact[key] ? `<a class="detail-row" href="${escapeHtml(normalizeHref(contact[key]))}" target="_blank" rel="noopener"><span>${iconMarkup('web')}</span><strong>${escapeHtml(key)} · ${escapeHtml(contact[key])}</strong></a>` : '')
            .filter(Boolean);
        if (socialRows.length) blocks.push(`<section class="detail-block"><h4>Social</h4>${socialRows.join('')}</section>`);
        const extra = [
            contact.department ? `<div class="detail-row"><span></span><strong>${escapeHtml(contact.department)}</strong></div>` : '',
            contact.industry && contact.industry !== 'Other' ? `<div class="detail-row"><span></span><strong>${escapeHtml(contact.industry)}</strong></div>` : '',
            contact.notes ? `<div class="detail-row"><span>${iconMarkup('note')}</span><strong>${escapeHtml(contact.notes)}</strong></div>` : '',
        ].filter(Boolean);
        if (extra.length) blocks.push(`<section class="detail-block"><h4>More</h4>${extra.join('')}</section>`);
        return blocks.join('');
    }

    function openContactDetail(contact) {
        const view = document.getElementById('contactDetailView');
        if (!view || !contact) return;
        contact = normalizeSavedCard(contact);
        activeDetailContact = contact;
        detailShowingBack = false;
        document.getElementById('contactDetailTitle').textContent = contact.name || 'Saved card';
        const front = contact.frontImage || contact.originalImageUrl || contact.cachedImageUrl || '';
        const back = contact.backImage || contact.originalBackImageUrl || '';
        const photo = document.getElementById('contactDetailPhoto');
        const photoBack = document.getElementById('contactDetailPhotoBack');
        const flipCard = document.getElementById('contactDetailFlipCard');
        flipCard?.classList.remove('is-flipped');
        if (front) {
            photo.onload = () => {
                if (photo.naturalWidth && photo.naturalHeight) {
                    flipCard.style.aspectRatio = `${photo.naturalWidth} / ${photo.naturalHeight}`;
                }
            };
            photo.src = front;
        }
        else photo.removeAttribute('src');
        if (back) photoBack.src = back;
        else photoBack.removeAttribute('src');
        flipCard?.classList.toggle('is-single', !back);
        const hint = document.getElementById('contactDetailFlipHint');
        if (hint) hint.textContent = back ? 'Front · Tap to flip · Hold to view' : 'Front · Hold to view';

        const role = [contact.title, contact.company].filter(Boolean).join(' · ');
        document.getElementById('contactDetailIdentity').innerHTML = `
            <h3>${escapeHtml(contact.name || 'Unnamed contact')}</h3>
            ${contact.title ? `<p>${escapeHtml(contact.title)}</p>` : ''}
            ${contact.company ? `<p>${escapeHtml(contact.company)}</p>` : ''}
            ${!contact.title && !contact.company && role ? `<p>${escapeHtml(role)}</p>` : ''}
        `;

        const quick = document.getElementById('contactDetailQuick');
        quick.innerHTML = `
            <button type="button" class="btn-luxury" id="contactDetailSave"><span>Save to Phone</span></button>
            <button type="button" class="chip-btn" id="contactDetailShare">Share Connection</button>
            <button type="button" class="chip-btn" id="contactDetailEditBtn">Edit</button>
        `;
        document.getElementById('contactDetailFields').innerHTML = renderDetailSections(contact);

        quick.querySelector('#contactDetailSave')?.addEventListener('click', () => {
            openSaveToPhoneModal(contact);
        });
        quick.querySelector('#contactDetailShare')?.addEventListener('click', async () => {
            const result = await shareVCardContent(await vcardForContact(contact), contact);
            if (result === 'fallback') showToast('Connection copied and downloaded', 'success');
            else if (result !== 'aborted') showToast('Connection shared', 'success');
        });
        quick.querySelector('#contactDetailEditBtn')?.addEventListener('click', () => showEditContactModal(contact));

        view.classList.remove('hidden');
        view.setAttribute('aria-hidden', 'false');
        document.body.classList.add('contact-detail-open');
        view.querySelector('.card-detail__scroll')?.scrollTo(0, 0);
        if (!history.state || history.state.folioCard !== contact.cardId) {
            history.pushState({ folioCard: contact.cardId }, '');
        }
    }

    document.getElementById('closeSaveToPhoneModal')?.addEventListener('click', closeSaveToPhoneModal);
    document.getElementById('saveToPhoneModal')?.addEventListener('click', (e) => {
        if (e.target?.id === 'saveToPhoneModal') closeSaveToPhoneModal();
    });
    document.getElementById('saveToPhoneForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const draft = readSaveToPhoneDraft();
        if (!draft.name && !draft.phone && !draft.email) {
            showToast('Add at least a name, phone, or email', 'error');
            return;
        }
        const result = await saveContactToDevice(draft);
        if (result === 'aborted') return;
        // Stay on this card page — only close the edit sheet, never jump to home/scan.
        closeSaveToPhoneModal();
        if (activeDetailContact || phoneSaveSourceContact) {
            const stay = activeDetailContact || phoneSaveSourceContact;
            // Re-assert detail view in case Android/history tried to dismiss it.
            if (document.getElementById('contactDetailView')?.classList.contains('hidden') && stay?.cardId) {
                const fresh = contactsData.find((c) => c.cardId === stay.cardId) || stay;
                openContactDetail(fresh);
            }
        }
        if (result === 'opened') showToast('Opening Add Contact… Stay on this card when you come back', 'success');
        else if (result === 'shared') showToast('Pick Contacts to finish saving', 'success');
        else if (result === 'downloaded') showToast('Contact file downloaded — open it to save', 'success');
        else if (result === 'failed') showToast('Could not open Contacts — try Share to Contacts', 'error');
    });

    document.getElementById('saveToPhoneShareFallback')?.addEventListener('click', async () => {
        const draft = readSaveToPhoneDraft();
        if (!draft.name && !draft.phone && !draft.email) {
            showToast('Add at least a name, phone, or email', 'error');
            return;
        }
        const result = await shareContactToAndroidContacts(draft);
        if (result === 'aborted') return;
        closeSaveToPhoneModal();
        if (result === 'shared') showToast('Pick Contacts (or Files → Open) to save', 'success');
        else if (result === 'opened') showToast('Opening contact file…', 'success');
        else showToast('Could not share contact', 'error');
    });

    document.getElementById('contactDetailBack')?.addEventListener('click', () => closeContactDetail());
    document.getElementById('contactDetailEdit')?.addEventListener('click', () => {
        if (activeDetailContact) showEditContactModal(activeDetailContact);
    });
    document.getElementById('contactDetailMore')?.addEventListener('click', () => {
        if (activeDetailContact) showEditContactModal(activeDetailContact);
    });
    document.getElementById('contactDetailDelete')?.addEventListener('click', async () => {
        if (!activeDetailContact) return;
        if (!confirm('Delete this saved card?')) return;
        const id = activeDetailContact.cardId;
        closeContactDetail();
        await deleteContact(id);
    });

    const cardPhotoLightbox = document.getElementById('cardPhotoLightbox');
    const cardPhotoLightboxImg = document.getElementById('cardPhotoLightboxImg');
    let skipFlipAfterHold = false;

    function currentDetailPhotoSrc() {
        if (!activeDetailContact) return '';
        if (detailShowingBack) {
            return activeDetailContact.originalBackImageUrl
                || activeDetailContact.backImage
                || '';
        }
        return activeDetailContact.originalImageUrl
            || activeDetailContact.frontImage
            || activeDetailContact.cachedImageUrl
            || '';
    }

    function openCardPhotoLightbox(src) {
        const url = src || currentDetailPhotoSrc();
        if (!url || !cardPhotoLightbox || !cardPhotoLightboxImg) return;
        cardPhotoLightboxImg.src = url;
        cardPhotoLightbox.classList.remove('hidden');
        cardPhotoLightbox.setAttribute('aria-hidden', 'false');
        document.body.classList.add('card-photo-open');
    }

    function closeCardPhotoLightbox() {
        if (!cardPhotoLightbox) return;
        cardPhotoLightbox.classList.add('hidden');
        cardPhotoLightbox.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('card-photo-open');
    }

    document.getElementById('cardPhotoLightboxClose')?.addEventListener('click', (event) => {
        event.stopPropagation();
        closeCardPhotoLightbox();
    });
    cardPhotoLightbox?.addEventListener('click', (event) => {
        if (event.target === cardPhotoLightbox || event.target === cardPhotoLightboxImg) {
            closeCardPhotoLightbox();
        }
    });

    const flipCardEl = document.getElementById('contactDetailFlipCard');
    if (flipCardEl) {
        let holdTimer = null;
        let startX = 0;
        let startY = 0;
        const clearHold = () => {
            if (holdTimer) {
                window.clearTimeout(holdTimer);
                holdTimer = null;
            }
        };
        flipCardEl.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            skipFlipAfterHold = false;
            startX = event.clientX;
            startY = event.clientY;
            clearHold();
            holdTimer = window.setTimeout(() => {
                holdTimer = null;
                skipFlipAfterHold = true;
                try { flipCardEl.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
                openCardPhotoLightbox();
            }, 430);
        });
        const cancelHold = (event) => {
            if (event && (Math.abs(event.clientX - startX) > 14 || Math.abs(event.clientY - startY) > 14)) {
                clearHold();
            }
        };
        flipCardEl.addEventListener('pointermove', cancelHold);
        flipCardEl.addEventListener('pointerup', clearHold);
        flipCardEl.addEventListener('pointercancel', clearHold);
        flipCardEl.addEventListener('contextmenu', (event) => event.preventDefault());
        flipCardEl.addEventListener('click', () => {
            if (skipFlipAfterHold) {
                skipFlipAfterHold = false;
                return;
            }
            if (!activeDetailContact) return;
            const back = activeDetailContact.backImage || activeDetailContact.originalBackImageUrl;
            if (!back) {
                openCardPhotoLightbox();
                return;
            }
            detailShowingBack = !detailShowingBack;
            flipCardEl.classList.toggle('is-flipped', detailShowingBack);
            const hintEl = document.getElementById('contactDetailFlipHint');
            if (hintEl) {
                hintEl.textContent = detailShowingBack ? 'Back · Tap to flip · Hold to view' : 'Front · Tap to flip · Hold to view';
            }
        });
    }
    document.getElementById('emptyScanBtn')?.addEventListener('click', () => {
        switchToTab('scan');
        startLiveCamera(document.getElementById('cameraPanel'));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (cardPhotoLightbox && !cardPhotoLightbox.classList.contains('hidden')) {
            closeCardPhotoLightbox();
            return;
        }
        if (!document.getElementById('contactDetailView')?.classList.contains('hidden')) {
            closeContactDetail();
        }
    });
    window.addEventListener('popstate', () => {
        if (closingDetailFromPop) {
            closingDetailFromPop = false;
            return;
        }
        // Returning from Android Contacts / intent must not kick you to the home/scan page.
        if (Date.now() < ignoreDetailPopUntil && activeDetailContact) {
            history.pushState({ folioCard: activeDetailContact.cardId }, '');
            return;
        }
        if (!document.getElementById('contactDetailView')?.classList.contains('hidden')) {
            closeContactDetail(true);
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!peekPhoneSaveReturn()) return;
        // Keep user on the same card after leaving the Contacts app.
        restoreContactAfterPhoneSave().catch(() => {});
    });

    window.addEventListener('pageshow', () => {
        if (!peekPhoneSaveReturn()) return;
        restoreContactAfterPhoneSave().catch(() => {});
    });

    // Reset Uploads
    resetBtn.addEventListener('click', () => {
        resetBtn.classList.add('hidden');
        if (processingStatus) processingStatus.textContent = '';
        uploadProgress.textContent = '';
        thumbnailGallery.innerHTML = '';
        scanCompleteMessage.classList.add('hidden');
        setScanProcessing(false);
        setUploadShimmer(false);
        pendingFrontUpload = null;
        const mascot = document.getElementById('scanMascot');
        const mascotLive = document.getElementById('scanMascotLive');
        if (mascot) mascot.src = 'assets/mascot-idle.svg';
        if (mascotLive) mascotLive.src = 'assets/mascot-idle.svg';
    });

    // Update createThumbnail function
    function createThumbnail(imageDataUrl, maxWidth = 150, maxHeight = 150, quality = 0.6) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = function() {
                // Calculate new dimensions while maintaining aspect ratio
                let width = img.width;
                let height = img.height;
                
                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round(height * (maxWidth / width));
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round(width * (maxHeight / height));
                        height = maxHeight;
                    }
                }
                
                // Create canvas and draw resized image
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // Convert to compressed data URL
                const thumbnailDataUrl = canvas.toDataURL('image/jpeg', quality);
                
                // Clean up
                resolve(thumbnailDataUrl);
            };
            img.src = imageDataUrl;
        });
    }

    // Process Single Business Card File
    async function compressImageFile(file, maxDim = 1400, quality = 0.72) {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Error reading file'));
            reader.readAsDataURL(file);
        });
        if (window.FolioCrop) {
            try {
                const source = await FolioCrop.loadCanvas(dataUrl);
                const cropped = FolioCrop.autoCrop(source);
                const frame = cropped.changed ? cropped.canvas : source;
                let { width, height } = frame;
                const scale = Math.min(1, maxDim / Math.max(width, height));
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(frame, 0, 0, width, height);
                return canvas.toDataURL('image/jpeg', quality);
            } catch (err) {
                console.warn('FolioCrop compress fallback', err);
            }
        }
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const cropped = cropToVisitingCard(img);
                let { width, height } = cropped;
                const scale = Math.min(1, maxDim / Math.max(width, height));
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(cropped, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    function canvasFromImage(source) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, source.width || source.videoWidth || 1);
        canvas.height = Math.max(1, source.height || source.videoHeight || 1);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    function centerCardBox(width, height) {
        const target = 1.65;
        let cropW;
        let cropH;
        if (width / height > target) {
            cropH = height * 0.86;
            cropW = cropH * target;
        } else {
            cropW = width * 0.9;
            cropH = cropW / target;
        }
        if (cropW > width) {
            cropW = width;
            cropH = cropW / target;
        }
        if (cropH > height) {
            cropH = height;
            cropW = cropH * target;
        }
        return {
            x: Math.max(0, (width - cropW) / 2),
            y: Math.max(0, (height - cropH) / 2),
            width: cropW,
            height: cropH,
        };
    }

    function detectCardBox(canvas) {
        const maxSide = 360;
        const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
        const w = Math.max(8, Math.round(canvas.width * scale));
        const h = Math.max(8, Math.round(canvas.height * scale));
        const probe = document.createElement('canvas');
        probe.width = w;
        probe.height = h;
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0, w, h);
        let data;
        try {
            data = ctx.getImageData(0, 0, w, h).data;
        } catch (err) {
            return centerCardBox(canvas.width, canvas.height);
        }
        const luma = new Uint8Array(w * h);
        for (let i = 0; i < luma.length; i += 1) {
            const j = i * 4;
            luma[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
        }
        const border = [];
        for (let x = 0; x < w; x += 1) {
            border.push(luma[x], luma[(h - 1) * w + x]);
        }
        for (let y = 0; y < h; y += 1) {
            border.push(luma[y * w], luma[y * w + w - 1]);
        }
        border.sort((a, b) => a - b);
        const bg = border[Math.floor(border.length / 2)];
        const thresh = 26;
        let minX = w;
        let minY = h;
        let maxX = 0;
        let maxY = 0;
        let count = 0;
        for (let y = 2; y < h - 2; y += 1) {
            for (let x = 2; x < w - 2; x += 1) {
                if (Math.abs(luma[y * w + x] - bg) > thresh) {
                    count += 1;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }
        const boxW = Math.max(1, maxX - minX);
        const boxH = Math.max(1, maxY - minY);
        const coverage = (boxW * boxH) / (w * h);
        const aspect = canvas.width / canvas.height;
        if (coverage < 0.14 || coverage > 0.94 || boxW < w * 0.28 || boxH < h * 0.22) {
            if (aspect > 1.35 && aspect < 2.15) {
                return { x: 0, y: 0, width: canvas.width, height: canvas.height };
            }
            return centerCardBox(canvas.width, canvas.height);
        }
        const padX = boxW * 0.04;
        const padY = boxH * 0.05;
        const x = Math.max(0, (minX - padX) / scale);
        const y = Math.max(0, (minY - padY) / scale);
        const width = Math.min(canvas.width - x, (boxW + padX * 2) / scale);
        const height = Math.min(canvas.height - y, (boxH + padY * 2) / scale);
        return { x, y, width, height };
    }

    function cropCanvas(source, box) {
        const x = Math.max(0, Math.floor(box.x));
        const y = Math.max(0, Math.floor(box.y));
        const width = Math.max(1, Math.min(source.width - x, Math.round(box.width)));
        const height = Math.max(1, Math.min(source.height - y, Math.round(box.height)));
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        out.getContext('2d').drawImage(source, x, y, width, height, 0, 0, width, height);
        return out;
    }

    function cropToVisitingCard(source) {
        if (window.FolioCrop) {
            return FolioCrop.autoCrop(source).canvas;
        }
        const canvas = source.tagName === 'CANVAS' ? source : canvasFromImage(source);
        if (canvas.width < 12 || canvas.height < 12) return canvas;
        return cropCanvas(canvas, detectCardBox(canvas));
    }

    async function cropAndConfirm(file, sideLabel) {
        if (!window.FolioCrop) return file;
        const url = URL.createObjectURL(file);
        try {
            const canvas = await FolioCrop.loadCanvas(url);
            const cropped = FolioCrop.autoCrop(canvas);
            if (!cropped.changed) return file;
            return FolioCrop.toFile(cropped.canvas, `folio-${sideLabel || 'card'}-${Date.now()}.jpg`);
        } catch (err) {
            console.warn('Silent card crop fallback', err);
            return file;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function recropStoredContact(contact) {
        if (!window.FolioCrop || !contact) return;
        const src = contact.originalImageUrl || contact.frontImage || contact.imageUrl || contact.cachedImageUrl;
        if (!src || !(src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http'))) return;
        try {
            const canvas = await FolioCrop.loadCanvas(src);
            if (!FolioCrop.needsRecrop(canvas)) {
                contact.frontImage = contact.frontImage || src;
                contact.originalImageUrl = contact.originalImageUrl || src;
                return;
            }
            const cropped = FolioCrop.autoCrop(canvas);
            contact.originalImageUrl = cropped.dataUrl;
            contact.frontImage = cropped.dataUrl;
            contact.cachedImageUrl = cropped.dataUrl;
            contact.imageUrl = cropped.dataUrl;
            try { localStorage.removeItem(`thumbnail_${contact.cardId}`); } catch (e) { /* ignore */ }
            try { localStorage.removeItem(`thumbnail_v2_${contact.cardId}`); } catch (e) { /* ignore */ }
            const backSrc = contact.originalBackImageUrl || contact.backImage;
            if (backSrc && (backSrc.startsWith('data:') || backSrc.startsWith('http'))) {
                const backCanvas = await FolioCrop.loadCanvas(backSrc);
                if (FolioCrop.needsRecrop(backCanvas)) {
                    const backCropped = FolioCrop.autoCrop(backCanvas);
                    contact.originalBackImageUrl = backCropped.dataUrl;
                    contact.backImage = backCropped.dataUrl;
                }
            }
        } catch (err) {
            console.warn('Could not recrop stored card', err);
        }
    }

    function mapOverlayToSourceBox(videoEl, overlayEl, sourceW, sourceH) {
        if (!videoEl || !overlayEl || !sourceW || !sourceH) return null;
        const videoRect = videoEl.getBoundingClientRect();
        const overlayRect = overlayEl.getBoundingClientRect();
        if (!videoRect.width || !overlayRect.width) return null;
        const videoAspect = sourceW / sourceH;
        const elAspect = videoRect.width / videoRect.height;
        let drawW;
        let drawH;
        let offX = 0;
        let offY = 0;
        if (videoAspect > elAspect) {
            drawH = videoRect.height;
            drawW = drawH * videoAspect;
            offX = (videoRect.width - drawW) / 2;
        } else {
            drawW = videoRect.width;
            drawH = drawW / videoAspect;
            offY = (videoRect.height - drawH) / 2;
        }
        const x = ((overlayRect.left - videoRect.left - offX) / drawW) * sourceW;
        const y = ((overlayRect.top - videoRect.top - offY) / drawH) * sourceH;
        const width = (overlayRect.width / drawW) * sourceW;
        const height = (overlayRect.height / drawH) * sourceH;
        const clampedX = Math.max(0, x);
        const clampedY = Math.max(0, y);
        return {
            x: clampedX,
            y: clampedY,
            width: Math.max(1, Math.min(sourceW - clampedX, width - (clampedX - x))),
            height: Math.max(1, Math.min(sourceH - clampedY, height - (clampedY - y))),
        };
    }

    function cropCanvasToGuide(sourceCanvas, videoEl, guideEl) {
        const box = mapOverlayToSourceBox(videoEl, guideEl, sourceCanvas.width, sourceCanvas.height);
        if (!box) return sourceCanvas;
        const inset = Math.min(box.width, box.height) * 0.012;
        box.x += inset;
        box.y += inset;
        box.width -= inset * 2;
        box.height -= inset * 2;
        if (box.width < 12 || box.height < 12) return sourceCanvas;
        return cropCanvas(sourceCanvas, box);
    }

    let ocrWorkerPromise = null;

    function tidyAddress(value) {
        let address = String(value || '').replace(/\s+/g, ' ').trim();
        if (!address) return '';
        address = address.replace(/\bChanna\b/gi, 'Chennai');
        address = address.replace(/\bChenai\b/gi, 'Chennai');
        address = address.replace(/\bChennat\b/gi, 'Chennai');
        if (/\b600\s?\d{3}\b/.test(address)) {
            address = address.replace(/\bChann[aei]+\b/gi, 'Chennai');
        }
        return address.replace(/[,\s]+$/g, '');
    }

    function repairPhoneDigits(digits) {
        let value = String(digits || '');
        if (value.length === 12 && value.startsWith('01') && /[6-9]/.test(value[2])) {
            value = `91${value.slice(2)}`;
        }
        if (value.length === 11 && value.startsWith('0') && /[6-9]/.test(value[1])) {
            value = value.slice(1);
        }
        if (value.length === 13 && value.startsWith('910') && /[6-9]/.test(value[3])) {
            value = `91${value.slice(3)}`;
        }
        return value;
    }

    function formatPhoneDigits(digits) {
        const value = repairPhoneDigits(digits);
        if (value.length === 12 && value.startsWith('91')) {
            return `+91 ${value.slice(2, 7)} ${value.slice(7)}`;
        }
        if (value.length === 10 && /[6-9]/.test(value[0])) {
            return `+91 ${value.slice(0, 5)} ${value.slice(5)}`;
        }
        if (value.length >= 8) return `+${value}`;
        return '';
    }

    function extractPhones(text) {
        const matches = String(text || '').match(/(?:\+|00)?\d[\d \t().\-/]{6,}\d/g) || [];
        const phones = [];
        const seen = new Set();
        matches.forEach((match) => {
            const digits = repairPhoneDigits(match.replace(/\D/g, ''));
            if (digits.length < 8 || digits.length > 15 || seen.has(digits)) return;
            const formatted = formatPhoneDigits(digits);
            if (!formatted) return;
            seen.add(digits);
            phones.push(formatted);
        });
        return phones.slice(0, 3);
    }

    function extractAddress(lines) {
        const hint = /\b(rd|road|st|street|ave|avenue|lane|nagar|layout|main|cross|block|floor|po box|city|near|opp|pin|plot|no\.?|chennai|mumbai|delhi|bengaluru|hyderabad|kolkata|pune)\b/i;
        const pin = /\b\d{3}\s?\d{3}\b/;
        const start = lines.findIndex((line) => hint.test(line) || pin.test(line) || /\d+[/,]\d+[A-Za-z]?/.test(line));
        if (start < 0) return '';
        const chunk = [];
        for (let i = start; i < Math.min(lines.length, start + 4); i += 1) {
            const line = lines[i];
            if (!line || line.includes('@')) continue;
            chunk.push(line);
            if (i > start && pin.test(line)) break;
        }
        return tidyAddress(chunk.join(', '));
    }

    function stripSideLabelPrefix(value) {
        let text = String(value || '').replace(/\s+/g, ' ').trim().replace(/^[\s\-:|]+|[\s\-:|]+$/g, '');
        if (!text) return '';
        if (/^(?:FRONT|BACK|FRONT\s+AND\s+BACK(?:\s+OF\s+THE\s+SAME\s+BUSINESS\s+CARD)?)\s*[:\-–—]?\s*$/i.test(text)) {
            return '';
        }
        text = text.replace(
            /^(?:FRONT|BACK)(?:\s+AND\s+BACK)?(?:\s+OF\s+THE\s+SAME\s+BUSINESS\s+CARD)?\s*[:\-–—]?\s*/i,
            ''
        ).trim().replace(/^[\s\-:|]+|[\s\-:|]+$/g, '');
        return text;
    }

    function scrubSideLabelsFromContact(contact) {
        if (!contact) return contact;
        ['name', 'company', 'department', 'title', 'jobTitle'].forEach((key) => {
            if (contact[key]) contact[key] = stripSideLabelPrefix(contact[key]);
        });
        return contact;
    }

    function parseCardTextLocally(rawText) {
        const text = (rawText || '').trim();
        const data = {
            name: '', company: '', department: '', title: '', email: '', phone: '',
            address: '', website: '', industry: 'Other', notes: '', tags: [], followUpDate: ''
        };
        if (!text) {
            data.notes = 'Could not read text automatically. Please edit this contact.';
            return data;
        }
        const emails = text.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || [];
        if (emails[0]) data.email = emails[0];
        const urls = text.match(/https?:\/\/[^\s]+|www\.[^\s]+/gi) || [];
        const website = urls.find((url) => !url.includes('@'));
        if (website) data.website = website.replace(/[.,;)]+$/, '');
        const phones = extractPhones(text);
        if (phones.length) data.phone = phones.join(' / ');
        const skip = new Set([
            data.email.toLowerCase(),
            data.website.toLowerCase(),
            'front',
            'back',
            ...phones.map((phone) => phone.toLowerCase()),
            ...phones.map((phone) => phone.replace(/\s/g, '')),
        ]);
        const leftover = text.split(/\n/).map((line) => stripSideLabelPrefix(line)).filter((line) => (
            line
            && !skip.has(line.toLowerCase())
            && !line.includes('@')
            && !/https?:\/\/|www\./i.test(line)
            && !/(?:\+|00)?\d[\d \t().\-/]{6,}\d/.test(line)
            && (line.match(/[A-Za-z]/g) || []).length >= 2
        ));
        const companyHint = /\b(inc|ltd|llc|pvt|gmbh|corp|co|company|group|studio|labs?|technologies|solutions|systems|enterprises|industries|traders|associates|facade)\b/i;
        if (leftover[0]) data.name = leftover[0].slice(0, 80);
        const companyLine = leftover.find((line) => companyHint.test(line));
        if (companyLine) {
            data.company = companyLine.slice(0, 80);
            if (data.name === data.company && leftover[1]) data.name = leftover[1].slice(0, 80);
        } else if (leftover[1]) {
            data.company = leftover[1].slice(0, 80);
        }
        const titleLine = leftover.find((line) => line !== data.name && line !== data.company);
        if (titleLine) data.title = titleLine.slice(0, 80);
        data.address = extractAddress(leftover);
        return scrubSideLabelsFromContact(data);
    }

    function repairContactFromOcr(contact, rawText) {
        if (!contact) return contact;
        scrubSideLabelsFromContact(contact);
        const parsed = parseCardTextLocally(rawText);
        const apiHasBadCode = /\+01\b/.test(contact.phone || '') || /(?:^|[^\d])01\s*\d{5}/.test(contact.phone || '');
        if (parsed.phone && (apiHasBadCode || !contact.phone)) {
            contact.phone = parsed.phone;
        } else if (contact.phone) {
            const repaired = extractPhones(contact.phone);
            if (repaired.length) contact.phone = repaired.join(' / ');
        }
        if (parsed.address && (!contact.address || parsed.address.length > String(contact.address).length + 3)) {
            contact.address = parsed.address;
        } else if (contact.address) {
            contact.address = tidyAddress(contact.address);
        }
        if (!contact.company && parsed.company) contact.company = parsed.company;
        if (!contact.email && parsed.email) contact.email = parsed.email;
        if (contact.name && /^front\b/i.test(contact.name)) {
            contact.name = stripSideLabelPrefix(contact.name) || parsed.name || contact.name;
        }
        return scrubSideLabelsFromContact(contact);
    }

    function contactLooksEmpty(contact) {
        if (!contact) return true;
        return !['name', 'company', 'title', 'email', 'phone', 'website']
            .some((key) => String(contact[key] || '').trim());
    }

    function scoreOcrText(text) {
        const value = (text || '').trim();
        if (!value) return -1;
        const emails = (value.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi) || []).length;
        const phones = (value.match(/(?:\+|00)?\d[\d \t().\-/]{6,}\d/g) || []).length;
        const urls = (value.match(/https?:\/\/|www\./gi) || []).length;
        const alnum = (value.match(/[A-Za-z0-9]/g) || []).length;
        if (alnum < 6) return 0;
        const words = value.split(/\s+/).filter(Boolean).length;
        const pin = (value.match(/\b\d{3}\s?\d{3}\b/g) || []).length;
        const india = /\+91|\b91\s?\d{10}\b/.test(value) ? 4 : 0;
        return emails * 10 + phones * 6 + urls * 4 + pin * 2 + india + Math.min(words, 50) * 0.35;
    }

    function enhanceOcrPixels(ctx, width, height, invert) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageData.data;
        for (let i = 0; i < pixels.length; i += 4) {
            let value = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
            if (invert) value = 255 - value;
            value = (value - 128) * 1.5 + 128;
            value = value < 112 ? Math.max(0, value - 22) : Math.min(255, value + 20);
            pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
        }
        ctx.putImageData(imageData, 0, 0);
    }

    async function prepareImageForOcr(dataUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                const minSide = Math.min(width, height);
                const scale = minSide < 1400 ? 1400 / minSide : (Math.max(width, height) > 2400 ? 2400 / Math.max(width, height) : 1);
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
                let mean = 160;
                try {
                    const probe = document.createElement('canvas');
                    probe.width = 72;
                    probe.height = 48;
                    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
                    probeCtx.drawImage(img, 0, 0, 72, 48);
                    const sample = probeCtx.getImageData(0, 0, 72, 48).data;
                    let sum = 0;
                    let count = 0;
                    for (let i = 0; i < sample.length; i += 4) {
                        sum += (sample[i] * 299 + sample[i + 1] * 587 + sample[i + 2] * 114) / 1000;
                        count += 1;
                    }
                    mean = sum / Math.max(1, count);
                } catch (err) {
                    console.warn('OCR brightness probe failed', err);
                }
                const dark = mean < 140;
                const render = (invert) => {
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.filter = 'grayscale(1)';
                    ctx.drawImage(img, 0, 0, width, height);
                    ctx.filter = 'none';
                    try {
                        enhanceOcrPixels(ctx, width, height, invert);
                    } catch (err) {
                        console.warn('OCR preprocess fallback:', err);
                    }
                    return canvas.toDataURL('image/jpeg', 0.95);
                };
                resolve({
                    primary: render(dark),
                    alternate: render(!dark),
                    dark,
                });
            };
            img.onerror = () => resolve({ primary: dataUrl, alternate: dataUrl, dark: false });
            img.src = dataUrl;
        });
    }

    async function ocrImageFile(source) {
        if (typeof Tesseract === 'undefined') return '';
        const sources = source && typeof source === 'object'
            ? [source.primary, source.alternate].filter(Boolean)
            : [source];
        const recognizeOnce = async (image, psm) => {
            if (Tesseract.createWorker) {
                if (!ocrWorkerPromise) {
                    ocrWorkerPromise = Tesseract.createWorker('eng');
                }
                const worker = await Promise.race([
                    ocrWorkerPromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('OCR worker timeout')), 35000)),
                ]);
                if (worker.setParameters) {
                    await worker.setParameters({
                        tessedit_pageseg_mode: String(psm),
                        preserve_interword_spaces: '1',
                    });
                }
                const result = await Promise.race([
                    worker.recognize(image),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), 20000)),
                ]);
                return (result?.data?.text || '').trim();
            }
            if (!Tesseract.recognize) return '';
            const result = await Promise.race([
                Tesseract.recognize(image, 'eng', { tessedit_pageseg_mode: String(psm), logger: () => {} }),
                new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
            ]);
            return (result?.data?.text || '').trim();
        };
        try {
            let best = '';
            let bestScore = -1;
            for (const image of sources) {
                for (const psm of [6, 4]) {
                    const text = await recognizeOnce(image, psm);
                    const score = scoreOcrText(text);
                    if (score > bestScore) {
                        best = text;
                        bestScore = score;
                    }
                    if (bestScore >= 14) return best;
                }
            }
            return best;
        } catch (err) {
            console.warn('Client OCR failed:', err);
            ocrWorkerPromise = null;
            return '';
        }
    }

    function rememberContacts(newContacts) {
        if (!newContacts?.length) return;
        contactsData = [...contactsData, ...newContacts];
        return cacheContactsSnapshot(contactsData);
    }

    function syncedImageUrl(cardId, side = 'front') {
        if (!cardId) return '';
        const sideQuery = side === 'back' ? '&side=back' : '';
        return `${API_URL}/images/${cardId}?userId=${encodeURIComponent(userId || '')}${sideQuery}`;
    }

    function applySyncedImagePointers(contact) {
        if (!contact?.cardId) return contact;
        const hasFront = contact.hasImage
            || (contact.imageUrl && !String(contact.imageUrl).startsWith('data:'))
            || contact.originalImageUrl
            || contact.frontImage;
        const hasBack = contact.hasBackImage
            || (contact.backImageUrl && !String(contact.backImageUrl).startsWith('data:'))
            || contact.originalBackImageUrl
            || contact.backImage;
        if (hasFront) {
            contact.imageUrl = contact.imageUrl && String(contact.imageUrl).startsWith('db:')
                ? contact.imageUrl
                : (contact.imageUrl || 'db:front');
            // Keep local data URL for immediate display if present; otherwise use API pointer.
            if (!contact.originalImageUrl || !String(contact.originalImageUrl).startsWith('data:')) {
                contact.originalImageUrl = syncedImageUrl(contact.cardId, 'front');
            }
            if (!contact.frontImage || !String(contact.frontImage).startsWith('data:')) {
                contact.frontImage = contact.originalImageUrl;
            }
        }
        if (hasBack) {
            contact.backImageUrl = contact.backImageUrl && String(contact.backImageUrl).startsWith('db:')
                ? contact.backImageUrl
                : (contact.backImageUrl || 'db:back');
            if (!contact.originalBackImageUrl || !String(contact.originalBackImageUrl).startsWith('data:')) {
                contact.originalBackImageUrl = syncedImageUrl(contact.cardId, 'back');
            }
            if (!contact.backImage || !String(contact.backImage).startsWith('data:')) {
                contact.backImage = contact.originalBackImageUrl;
            }
        }
        return contact;
    }

    async function fetchContactImageDataUrl(cardId, side = 'front') {
        const url = syncedImageUrl(cardId, side);
        const response = await fetch(url, {
            headers: authHeaders(),
            credentials: 'include',
        });
        if (!response.ok) {
            throw new Error(`Image ${response.status}`);
        }
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function mergeContactFields(base, extra) {
        const merged = { ...(base || {}) };
        Object.entries(extra || {}).forEach(([key, value]) => {
            if (value === undefined || value === null || value === '') return;
            if (!merged[key]) merged[key] = value;
        });
        return merged;
    }

    async function processBusinessCardSides(files) {
        const sides = Array.from(files || []).filter(Boolean).slice(0, 2);
        if (!sides.length) throw new Error('No card image provided');

        const payloads = [];
        for (let i = 0; i < sides.length; i += 1) {
            const file = sides[i];
            if (!file || !file.type.startsWith('image/')) {
                throw new Error('Invalid file type. Please upload an image.');
            }
            if (file.size > 12 * 1024 * 1024) {
                throw new Error('File too large. Maximum size is 12MB.');
            }
            const preparing = sides.length > 1
                ? `Preparing ${i === 0 ? 'front' : 'back'}…`
                : 'Preparing card…';
            if (processingStatus) processingStatus.textContent = preparing;
            setScanProcessing(true, 'Reading your card', 'Using AI vision');
            const imageDataUrl = await compressImageFile(file);
            payloads.push({
                imageDataUrl,
                imageBase64: imageDataUrl.split(',')[1],
                rawText: '',
            });
        }

        const withImages = (contact) => {
            if (!contact) return contact;
            // Local preview for this device right after scan…
            contact.originalImageUrl = payloads[0].imageDataUrl;
            contact.frontImage = payloads[0].imageDataUrl;
            contact.cachedImageUrl = payloads[0].imageDataUrl;
            contact.imageUrl = contact.imageUrl || 'db:front';
            contact.originalBackImageUrl = payloads[1]?.imageDataUrl || contact.originalBackImageUrl || '';
            contact.backImage = payloads[1]?.imageDataUrl || contact.backImage || '';
            if (payloads[1]) contact.backImageUrl = contact.backImageUrl || 'db:back';
            contact.hasImage = true;
            contact.hasBackImage = Boolean(payloads[1]);
            contact.sides = payloads.length;
            contact.jobTitle = contact.jobTitle || contact.title || '';
            contact.syncStatus = 'synced';
            return applySyncedImagePointers(contact);
        };

        const runDeviceOcr = async () => {
            setScanProcessing(true, 'Reading your card', 'Trying a second pass on this device');
            for (let i = 0; i < payloads.length; i += 1) {
                const reading = payloads.length > 1
                    ? `Reading ${i === 0 ? 'front' : 'back'} of card…`
                    : 'Reading card text…';
                if (processingStatus) processingStatus.textContent = reading;
                const ocrSource = await prepareImageForOcr(payloads[i].imageDataUrl);
                payloads[i].rawText = await ocrImageFile(ocrSource);
            }
            const combinedText = payloads.map((payload, index) => {
                const label = payloads.length > 1 ? (index === 0 ? 'FRONT' : 'BACK') : '';
                return label ? `${label}\n${payload.rawText}` : payload.rawText;
            }).join('\n\n');
            const localContact = withImages({
                ...parseCardTextLocally(combinedText),
                userId,
                cardId: (crypto.randomUUID && crypto.randomUUID()) || `local-${Date.now()}`,
                dateAdded: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            return repairContactFromOcr(localContact, combinedText);
        };

        if (processingStatus) processingStatus.textContent = 'Reading with AI vision…';
        setScanProcessing(true, 'Reading your card', 'Using AI vision');

        try {
            const response = await fetch(`${API_URL}/scan`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    images: payloads.map((payload) => payload.imageBase64),
                    rawTexts: payloads.map((payload) => payload.rawText),
                    twoSided: payloads.length > 1,
                    userId: userId
                })
            });

            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }

            const result = await response.json();
            let newContacts = result?.contacts || [];
            if (newContacts.length && !contactLooksEmpty(newContacts[0])) {
                newContacts = newContacts.map((contact, index) => withImages(index === 0 ? contact : contact));
                await rememberContacts(newContacts);
                return { contacts: newContacts };
            }
        } catch (err) {
            console.warn('AI vision scan failed, falling back to on-device OCR:', err);
        }

        const localContact = await runDeviceOcr();
        if (processingStatus) processingStatus.textContent = 'Saving contact…';
        setScanProcessing(true, 'Saving your card', 'Almost done');
        try {
            const response = await fetch(`${API_URL}/scan`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({
                    images: payloads.map((payload) => payload.imageBase64),
                    rawTexts: payloads.map((payload) => payload.rawText),
                    twoSided: payloads.length > 1,
                    userId: userId
                })
            });
            if (response.ok) {
                const result = await response.json();
                let newContacts = result?.contacts || [];
                if (newContacts.length) {
                    newContacts = newContacts.map((contact, index) => {
                        const merged = contactLooksEmpty(contact)
                            ? mergeContactFields(localContact, contact)
                            : mergeContactFields(contact, localContact);
                        return withImages(index === 0 ? repairContactFromOcr(merged, payloads.map((p) => p.rawText).join('\n\n')) : merged);
                    });
                    await rememberContacts(newContacts);
                    return { contacts: newContacts };
                }
            }
        } catch (err) {
            console.warn('Scan API failed, saving locally from OCR:', err);
        }
        localContact.syncStatus = 'local-only';
        await rememberContacts([localContact]);
        if (typeof showToast === 'function') {
            showToast('Saved on this device only — cloud sync failed. Check your connection and try again.', 'warning');
        }
        return { contacts: [localContact] };
    }

    async function processBusinessCardFile(file) {
        return processBusinessCardSides([file]);
    }
    
    // Function to show original image in a modal
    function showOriginalImage(contactOrUrl) {
        const contact = contactOrUrl && typeof contactOrUrl === 'object'
            ? contactOrUrl
            : { originalImageUrl: contactOrUrl };
        const frontUrl = contact.originalImageUrl || '';
        const backUrl = contact.originalBackImageUrl || '';
        let imageModal = document.getElementById('originalImageModal');
        if (!imageModal) {
            const modalHtml = `
                <div id="originalImageModal" class="fixed inset-0 bg-black bg-opacity-75 hidden flex items-center justify-center z-50">
                    <div class="relative max-w-4xl w-full mx-4 card-preview-modal">
                        <button id="closeImageModal" class="absolute top-2 right-2 bg-white rounded-full p-1 shadow-lg" type="button" aria-label="Close">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                        <div id="cardPreviewTabs" class="card-preview-tabs hidden">
                            <button type="button" id="cardPreviewFrontBtn" class="card-preview-tab is-active">Front</button>
                            <button type="button" id="cardPreviewBackBtn" class="card-preview-tab">Back</button>
                        </div>
                        <img id="originalImage" src="" alt="Original business card" class="max-h-[90vh] max-w-full object-contain rounded shadow-lg">
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            imageModal = document.getElementById('originalImageModal');
            document.getElementById('closeImageModal').addEventListener('click', () => {
                imageModal.classList.add('hidden');
            });
            imageModal.addEventListener('click', (e) => {
                if (e.target === imageModal) {
                    imageModal.classList.add('hidden');
                }
            });
            document.getElementById('cardPreviewFrontBtn').addEventListener('click', () => {
                const img = document.getElementById('originalImage');
                img.src = imageModal.dataset.frontUrl || img.src;
                document.getElementById('cardPreviewFrontBtn').classList.add('is-active');
                document.getElementById('cardPreviewBackBtn').classList.remove('is-active');
            });
            document.getElementById('cardPreviewBackBtn').addEventListener('click', () => {
                const img = document.getElementById('originalImage');
                img.src = imageModal.dataset.backUrl || img.src;
                document.getElementById('cardPreviewBackBtn').classList.add('is-active');
                document.getElementById('cardPreviewFrontBtn').classList.remove('is-active');
            });
        }

        imageModal.dataset.frontUrl = frontUrl;
        imageModal.dataset.backUrl = backUrl;
        const tabs = document.getElementById('cardPreviewTabs');
        const frontBtn = document.getElementById('cardPreviewFrontBtn');
        const backBtn = document.getElementById('cardPreviewBackBtn');
        tabs.classList.toggle('hidden', !backUrl);
        frontBtn.classList.add('is-active');
        backBtn.classList.remove('is-active');
        document.getElementById('originalImage').src = frontUrl || backUrl;
        imageModal.classList.remove('hidden');
    }

    // Track if contacts are currently being loaded
    async function hydrateContactsFromCache() {
        const cached = await loadCachedContactsSnapshot();
        if (!cached?.length) return false;
        contactsData = cached
            .filter((c) => c && c.cardId !== '__PROFILE__' && c.kind !== 'profile' && c.kind !== 'slug-alias')
            .map((c) => {
                const contact = normalizeSavedCard({ ...c });
                applySyncedImagePointers(contact);
                const thumb = localStorage.getItem(`thumbnail_v2_${contact.cardId}`);
                if (thumb) contact.cachedImageUrl = thumb;
                return contact;
            });
        updateTagFilterOptions();
        updateFollowUpHint();
        filterAndSortContacts();
        return contactsData.length > 0;
    }

    async function enrichContactMedia(contact) {
        normalizeSavedCard(contact);
        applySyncedImagePointers(contact);
        try {
            const needsFrontFetch = contact.hasImage
                || (contact.imageUrl && String(contact.imageUrl).startsWith('db:'))
                || (contact.originalImageUrl && String(contact.originalImageUrl).includes('/images/'));
            const needsBackFetch = contact.hasBackImage
                || (contact.backImageUrl && String(contact.backImageUrl).startsWith('db:'))
                || (contact.originalBackImageUrl && String(contact.originalBackImageUrl).includes('/images/'));

            if (needsFrontFetch && (!contact.originalImageUrl || !String(contact.originalImageUrl).startsWith('data:'))) {
                contact.originalImageUrl = syncedImageUrl(contact.cardId, 'front');
            }
            if (needsBackFetch && (!contact.originalBackImageUrl || !String(contact.originalBackImageUrl).startsWith('data:'))) {
                contact.originalBackImageUrl = syncedImageUrl(contact.cardId, 'back');
            }

            const cachedThumbnail = localStorage.getItem(`thumbnail_v2_${contact.cardId}`);
            if (cachedThumbnail) {
                contact.cachedImageUrl = cachedThumbnail;
            } else if (contact.originalImageUrl && contact.originalImageUrl.startsWith('data:')) {
                const thumbnailDataUrl = await createThumbnail(contact.originalImageUrl, 720, 420, 0.82);
                try {
                    localStorage.setItem(`thumbnail_v2_${contact.cardId}`, thumbnailDataUrl);
                } catch (e) {
                    console.warn('Could not cache thumbnail in localStorage:', e);
                }
                contact.cachedImageUrl = thumbnailDataUrl;
            } else if (needsFrontFetch) {
                try {
                    const imageDataUrl = await fetchContactImageDataUrl(contact.cardId, 'front');
                    contact.originalImageUrl = imageDataUrl;
                    contact.frontImage = imageDataUrl;
                    await recropStoredContact(contact);
                    const thumbnailDataUrl = await createThumbnail(contact.originalImageUrl, 720, 420, 0.82);
                    try {
                        localStorage.setItem(`thumbnail_v2_${contact.cardId}`, thumbnailDataUrl);
                    } catch (e) {
                        console.warn('Could not cache thumbnail in localStorage:', e);
                    }
                    contact.cachedImageUrl = thumbnailDataUrl;
                } catch (imgErr) {
                    console.warn(`Could not fetch synced image for ${contact.cardId}:`, imgErr);
                    contact.cachedImageUrl = contact.originalImageUrl || '';
                }
            }

            if (needsBackFetch && (!contact.originalBackImageUrl || String(contact.originalBackImageUrl).includes('/images/'))) {
                try {
                    contact.originalBackImageUrl = await fetchContactImageDataUrl(contact.cardId, 'back');
                    contact.backImage = contact.originalBackImageUrl;
                } catch (backErr) {
                    console.warn(`Could not fetch back image for ${contact.cardId}:`, backErr);
                }
            }

            await recropStoredContact(contact);
            normalizeSavedCard(contact);
        } catch (error) {
            console.warn(`Error creating thumbnail for contact ${contact.cardId}:`, error);
            contact.cachedImageUrl = contact.originalImageUrl || contact.frontImage;
        }
    }

    async function loadContacts() {
        if (!userId) {
            console.error('No userId available');
            return;
        }

        if (loadContactsPromise) {
            console.log('Already loading contacts, skipping duplicate call');
            return loadContactsPromise;
        }

        isLoadingContacts = true;
        showContactsLoading(
            'Restoring your cards…',
            'Fetching saved contacts from your account.'
        );

        loadContactsPromise = (async () => {
            try {
                // Instant paint from device cache while the network request runs.
                const hadCache = await hydrateContactsFromCache();
                if (hadCache) {
                    showContactsLoading(
                        'Syncing your cards…',
                        'Updating from your account — almost there.'
                    );
                    // Keep list visible under a soft sync state: hide full-page empty loader
                    // once we already have cached cards to show.
                    if (contactsData.length > 0) hideContactsLoading();
                }

                const response = await fetch(`${API_URL}/contacts?userId=${encodeURIComponent(userId)}`, {
                    headers: authHeaders(),
                    credentials: 'include',
                });
                if (!response.ok) {
                    throw new Error('Failed to load contacts');
                }

                const data = await response.json();
                console.log('Loaded contacts data:', data);

                if (Array.isArray(data)) {
                    contactsData = data;
                } else if (data.contacts && Array.isArray(data.contacts)) {
                    contactsData = data.contacts;
                } else {
                    console.error('Invalid contacts data format:', data);
                    showToast('Error loading contacts: Invalid data format', 'error');
                    return;
                }
                contactsData = contactsData.filter((c) => c && c.cardId !== '__PROFILE__' && c.kind !== 'profile' && c.kind !== 'slug-alias');

                for (const contact of contactsData) {
                    normalizeSavedCard(contact);
                    applySyncedImagePointers(contact);
                    const thumb = localStorage.getItem(`thumbnail_v2_${contact.cardId}`);
                    if (thumb) contact.cachedImageUrl = thumb;
                }

                // Paint the list immediately — don't wait on image downloads.
                isLoadingContacts = false;
                hideContactsLoading();
                await cacheContactsSnapshot(contactsData);
                updateTagFilterOptions();
                updateFollowUpHint();
                filterAndSortContacts();
                try {
                    updateNetworkVisualization();
                    updateNetworkAnalytics();
                } catch (vizErr) {
                    console.warn('Viz update deferred:', vizErr);
                }

                // Enrich images/thumbnails in the background, then refresh previews.
                for (const contact of contactsData) {
                    await enrichContactMedia(contact);
                }
                await cacheContactsSnapshot(contactsData);
                filterAndSortContacts();
                try {
                    updateNetworkVisualization();
                    updateNetworkAnalytics();
                } catch (vizErr) {
                    console.warn('Viz update skipped:', vizErr);
                }
            } catch (error) {
                console.error('Error loading contacts:', error);
                const cached = await loadCachedContactsSnapshot();
                if (cached && cached.length) {
                    contactsData = cached;
                    for (const contact of contactsData) {
                        normalizeSavedCard(contact);
                        await recropStoredContact(contact);
                    }
                    await cacheContactsSnapshot(contactsData);
                    updateTagFilterOptions();
                    updateFollowUpHint();
                    filterAndSortContacts();
                    try {
                        updateNetworkVisualization();
                        updateNetworkAnalytics();
                    } catch (vizErr) {
                        console.warn('Offline viz update skipped:', vizErr);
                    }
                    showToast('Offline — showing cached contacts', 'warning');
                } else {
                    showToast('Failed to load contacts', 'error');
                    filterAndSortContacts();
                }
            } finally {
                isLoadingContacts = false;
                hideContactsLoading();
                if (contactsData.length === 0) {
                    filterAndSortContacts();
                }
                loadContactsPromise = null;
            }
        })();

        return loadContactsPromise;
    }

    // Global functions for contact management
    async function deleteContact(cardId) {
        if (!userId) {
            console.error('No userId available');
            showToast('Please sign in to delete contacts', 'error');
            return;
        }

        // Store the cardId in the modal's dataset
        deleteContactModal.dataset.cardId = cardId;
        // Show the modal
        deleteContactModal.classList.remove('hidden');
    }

    function showEditContactModal(contact) {
        // If we received a cardId instead of a contact object, find the contact
        if (typeof contact === 'string') {
            const cardId = contact;
            contact = contactsData.find(c => c.cardId === cardId);
            if (!contact) {
                console.error('Contact not found for cardId:', cardId);
                showToast('Error: Contact not found');
                return;
            }
        }

        // Debug: Log contact object to check for problematic characters
        console.debug('showEditContactModal: contact object:', contact);

        const modal = document.getElementById('editContactModal');
        const form = document.getElementById('editContactForm');

        // Store the original contact data
        form.dataset.originalContact = JSON.stringify(contact);

        // Defensive: Ensure all fields exist and are strings
        try {
            document.getElementById('editCardId').value = contact.cardId || '';
            document.getElementById('editName').value = contact.name || '';
            document.getElementById('editTitle').value = contact.title || '';
            document.getElementById('editCompany').value = contact.company || '';
            document.getElementById('editDepartment').value = contact.department || '';
            document.getElementById('editIndustry').value = contact.industry || '';
            document.getElementById('editEmail').value = contact.email || '';
            document.getElementById('editPhone').value = contact.phone || '';
            document.getElementById('editWebsite').value = contact.website || '';
            document.getElementById('editAddress').value = contact.address || '';
            document.getElementById('editTags').value = (Array.isArray(contact.tags) ? contact.tags : parseTagsInput(contact.tags)).join(', ');
            document.getElementById('editNotes').value = contact.notes || '';
            document.getElementById('editFollowUpDate').value = contact.followUpDate || '';
            const dateAdded = contact.dateAdded ? String(contact.dateAdded).slice(0, 10) : '';
            document.getElementById('editDateAdded').value = dateAdded;
        } catch (err) {
            console.error('showEditContactModal: Error setting input values', err, contact);
            showToast('Error populating edit modal fields');
        }

        // Debug: Log the address value being set
        console.debug('showEditContactModal: address value:', contact.address);

        // Show the modal
        modal.classList.remove('hidden');
        
        // Focus the first input field
        document.getElementById('editName').focus();
        
        // Prevent body scrolling when modal is open
        document.body.style.overflow = 'hidden';
    }

    function hideEditContactModal() {
        const modal = document.getElementById('editContactModal');
        modal.classList.add('hidden');
        // Restore body scrolling
        document.body.style.overflow = '';
    }

    // Update event listeners for modal closing
    document.getElementById('closeEditModal').addEventListener('click', hideEditContactModal);
    document.getElementById('cancelEditBtn').addEventListener('click', hideEditContactModal);

    // Close modal when clicking outside
    document.getElementById('editContactModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            hideEditContactModal();
        }
    });

    // Close modal on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('editContactModal').classList.contains('hidden')) {
            hideEditContactModal();
        }
    });

    // Update form submission to use the new hide function
    editContactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const originalContact = JSON.parse(form.dataset.originalContact);
        
        // Create updated contact object, preserving all original fields
        const updatedContact = {
            name: document.getElementById('editName').value,
            title: document.getElementById('editTitle').value,
            company: document.getElementById('editCompany').value,
            department: document.getElementById('editDepartment').value,
            industry: document.getElementById('editIndustry').value,
            email: document.getElementById('editEmail').value,
            phone: document.getElementById('editPhone').value,
            website: document.getElementById('editWebsite').value,
            address: document.getElementById('editAddress').value,
            notes: document.getElementById('editNotes').value,
            tags: parseTagsInput(document.getElementById('editTags').value),
            followUpDate: document.getElementById('editFollowUpDate').value || '',
            dateAdded: document.getElementById('editDateAdded').value
        };
        
        console.log('Updating contact:', updatedContact);
        
        try {
            const response = await fetch(`${API_URL}/contacts/${originalContact.cardId}?userId=${encodeURIComponent(userId)}`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(updatedContact)
            });

            if (!response.ok) {
                throw new Error('Failed to update contact');
            }

            const persisted = normalizeSavedCard({
                ...originalContact,
                ...updatedContact,
                originalImageUrl: originalContact.originalImageUrl,
                originalBackImageUrl: originalContact.originalBackImageUrl,
                frontImage: originalContact.frontImage || originalContact.originalImageUrl,
                backImage: originalContact.backImage || originalContact.originalBackImageUrl,
                cachedImageUrl: originalContact.cachedImageUrl,
                imageUrl: originalContact.imageUrl || 'db:front',
                backImageUrl: originalContact.backImageUrl,
                hasImage: originalContact.hasImage !== false,
                hasBackImage: Boolean(originalContact.hasBackImage || originalContact.backImageUrl),
                updatedAt: new Date().toISOString(),
            });
            applySyncedImagePointers(persisted);            const index = contactsData.findIndex(c => c.cardId === originalContact.cardId);
            if (index !== -1) {
                contactsData[index] = persisted;
            }

            await cacheContactsSnapshot(contactsData);
            updateTagFilterOptions();
            
            hideEditContactModal();
            refreshAllVisualizations();
            if (activeDetailContact && activeDetailContact.cardId === persisted.cardId) {
                openContactDetail(persisted);
            }
            if (pendingReviewContact && pendingReviewContact.cardId === persisted.cardId) {
                openScanReview(persisted);
            }
            showToast('Card updated', 'success');
        } catch (error) {
            console.error('Error updating contact:', error);
            const persisted = normalizeSavedCard({
                ...originalContact,
                ...updatedContact,
                originalImageUrl: originalContact.originalImageUrl,
                originalBackImageUrl: originalContact.originalBackImageUrl,
                frontImage: originalContact.frontImage || originalContact.originalImageUrl,
                backImage: originalContact.backImage || originalContact.originalBackImageUrl,
                cachedImageUrl: originalContact.cachedImageUrl,
                updatedAt: new Date().toISOString(),
            });
            const index = contactsData.findIndex(c => c.cardId === originalContact.cardId);
            if (index !== -1) {
                contactsData[index] = persisted;
                await cacheContactsSnapshot(contactsData);
                updateTagFilterOptions();
                hideEditContactModal();
                refreshAllVisualizations();
                if (activeDetailContact && activeDetailContact.cardId === persisted.cardId) {
                    openContactDetail(persisted);
                }
                if (pendingReviewContact && pendingReviewContact.cardId === persisted.cardId) {
                    openScanReview(persisted);
                }
                showToast('Card updated on this device', 'success');
                return;
            }
            showToast('Failed to update contact', 'error');
        }
    });

    // Function to update network visualization
    function updateNetworkVisualization() {
        const networkContainer = document.getElementById('networkGraph');
        const emptyNetworkMsg = document.getElementById('minContactsMessage');
        
        try {
            if (!networkContainer) {
                console.error('Network container element not found');
                return;
            }

            // Clear previous content
            networkContainer.innerHTML = '';
            
            // If there are fewer than 2 contacts, show the message and don't render the visualization
            if (!contactsData || contactsData.length < 2) {
                // Create or show the message element
                networkContainer.innerHTML = `
                    <div id="minContactsMessage" class="flex items-center justify-center h-64 text-gray-500">
                        Add at least 2 contacts to see a network visualization
                    </div>
                `;
                
                // Update charts too for consistency
                updateCompanyDistributionChart();
                updateIndustryInsightsChart();
                
                return;
            }
            
            // Stop any existing simulation
            if (window.currentSimulation) {
                try {
                    window.currentSimulation.stop();
                } catch (e) {
                    console.log('Error stopping previous simulation:', e);
                }
                window.currentSimulation = null;
            }
            
            // D3 Network Visualization Implementation
            
            // Get the view type (company, industry, location)
            const viewType = document.getElementById('networkViewType')?.value || 'company';
            
            // Set up the SVG container with responsive dimensions
            const width = networkContainer.clientWidth;
            const height = networkContainer.clientHeight || 400;
            
            const svg = d3.select("#networkGraph")
                .append("svg")
                .attr("width", width)
                .attr("height", height)
                .attr("viewBox", [0, 0, width, height])
                .attr("style", "max-width: 100%; height: auto;");
            
            // Add zoom behavior
            const zoom = d3.zoom()
                .scaleExtent([0.5, 5])
                .on("zoom", (event) => {
                    g.attr("transform", event.transform);
                });
            
            svg.call(zoom);
            
            // Create a group for all elements to enable zooming
            const g = svg.append("g");
            
            // Create the graph data structure
            const nodes = [];
            const links = [];
            
            // Add user as central node
            nodes.push({
                id: "user",
                name: "You",
                group: "center",
                radius: 20
            });
            
            // Process contacts based on view type
            const groupedContacts = {};
            
            contactsData.forEach(contact => {
                let groupKey;
                
                switch(viewType) {
                    case 'industry':
                        // Use the industry field directly from the contact
                        groupKey = contact.industry || "Unknown";
                        break;
                    case 'location':
                        // Extract location from address if available
                        groupKey = extractLocation(contact.address) || "Unknown";
                        break;
                    case 'company':
                    default:
                        groupKey = contact.company || "Unknown";
                }
                
                if (!groupedContacts[groupKey]) {
                    groupedContacts[groupKey] = [];
                    
                    // Add a group node
                    nodes.push({
                        id: `group-${groupKey}`,
                        name: groupKey,
                        group: groupKey,
                        radius: 15,
                        isGroupNode: true
                    });
                    
                    // Link group to center
                    links.push({
                        source: "user",
                        target: `group-${groupKey}`,
                        value: 1
                    });
                }
                
                // Add contact to group
                groupedContacts[groupKey].push(contact);
                
                // Add contact node
                nodes.push({
                    id: contact.cardId,
                    name: contact.name || "Unknown",
                    title: contact.title || "",
                    company: contact.company || "",
                    email: contact.email || "",
                    phone: contact.phone || "",
                    group: groupKey,
                    radius: 8,
                    imageUrl: contact.cachedImageUrl
                });
                
                // Link contact to its group
                links.push({
                    source: `group-${groupKey}`,
                    target: contact.cardId,
                    value: 1
                });
            });
            
            // Create a color scale for groups
            const groups = [...new Set(nodes.map(d => d.group))];
            const color = d3.scaleOrdinal()
                .domain(groups)
                .range(d3.schemeCategory10);
            
            // Create the force simulation with improved forces
            const simulation = d3.forceSimulation(nodes)
                .force("link", d3.forceLink(links).id(d => d.id).distance(d => {
                    // Different distances based on node types
                    if (d.source.id === "user" || d.target.id === "user") return 80;
                    return 40;
                }))
                .force("charge", d3.forceManyBody().strength(d => {
                    // Different strengths based on node types
                    if (d.id === "user") return -300;
                    if (d.isGroupNode) return -150;
                    return -50;
                }))
                .force("center", d3.forceCenter(width / 2, height / 2))
                .force("collision", d3.forceCollide().radius(d => d.radius * 1.5))
                .force("x", d3.forceX(width / 2).strength(0.05))
                .force("y", d3.forceY(height / 2).strength(0.05));
            
            // Create links
            const link = g.append("g")
                .selectAll("line")
                .data(links)
                .join("line")
                .attr("stroke", "#999")
                .attr("stroke-opacity", 0.6)
                .attr("stroke-width", d => Math.sqrt(d.value));
            
            // Create node groups
            const node = g.append("g")
                .selectAll("g")
                .data(nodes)
                .join("g")
                .call(drag(simulation));
            
            // Add circles to nodes
            node.append("circle")
                .attr("r", d => d.radius)
                .attr("fill", d => {
                    if (d.id === "user") return "#4f46e5"; // Indigo for user
                    if (d.isGroupNode) return color(d.group);
                    return d3.color(color(d.group)).brighter(0.5);
                })
                .attr("stroke", d => d3.color(color(d.group)).darker(0.5))
                .attr("stroke-width", 1.5);
            
            // Add labels to nodes
            node.append("text")
                .attr("dx", d => d.radius + 5)
                .attr("dy", ".35em")
                .text(d => d.name)
                .attr("font-size", d => {
                    if (d.id === "user" || d.isGroupNode) return "12px";
                    return "10px";
                })
                .attr("fill", "#333");
            
            // Add tooltips
            node.append("title")
                .text(d => {
                    if (d.id === "user") return "You";
                    if (d.isGroupNode) return `Group: ${d.name}`;
                    return `${d.name}\n${d.title}\n${d.company}\n${d.email}\n${d.phone}`;
                });
            
            // Update positions on tick
            simulation.on("tick", () => {
                link
                    .attr("x1", d => d.source.x)
                    .attr("y1", d => d.source.y)
                    .attr("x2", d => d.target.x)
                    .attr("y2", d => d.target.y);
                    
                node.attr("transform", d => `translate(${d.x},${d.y})`);
            });
            
            // Add legend
            const legend = svg.append("g")
                .attr("class", "legend")
                .attr("transform", `translate(10, 10)`);
            
            legend.append("circle")
                .attr("r", 6)
                .attr("cx", 6)
                .attr("cy", 6)
                .attr("fill", "#4f46e5");
            
            legend.append("text")
                .attr("x", 18)
                .attr("y", 10)
                .text("You")
                .attr("font-size", "12px");
            
            legend.append("circle")
                .attr("r", 6)
                .attr("cx", 6)
                .attr("cy", 26)
                .attr("fill", color(groups[0] || "Unknown"));
            
            legend.append("text")
                .attr("x", 18)
                .attr("y", 30)
                .text("Group")
                .attr("font-size", "12px");
            
            legend.append("circle")
                .attr("r", 6)
                .attr("cx", 6)
                .attr("cy", 46)
                .attr("fill", d3.color(color(groups[0] || "Unknown")).brighter(0.5));
            
            legend.append("text")
                .attr("x", 18)
                .attr("y", 50)
                .text("Contact")
                .attr("font-size", "12px");
            
            // Run simulation for a bit to stabilize the layout
            simulation.alpha(1).restart();
            for (let i = 0; i < 100; ++i) simulation.tick();
            
            // Update network analytics
            updateNetworkAnalytics(groupedContacts);
            
            // Add event listener for view type change
            document.getElementById('networkViewType')?.addEventListener('change', updateNetworkVisualization);
            
            // Add event listener for fullscreen button
            document.getElementById('fullscreenNetworkBtn')?.addEventListener('click', toggleFullscreenNetwork);
            
            // Add reset zoom button
            const resetZoomBtn = document.createElement('button');
            resetZoomBtn.className = 'bg-gray-200 hover:bg-gray-300 p-1 rounded absolute top-4 right-4';
            resetZoomBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
            `;
            resetZoomBtn.addEventListener('click', () => {
                svg.transition().duration(750).call(
                    zoom.transform,
                    d3.zoomIdentity
                );
            });
            networkContainer.appendChild(resetZoomBtn);
            
            // Store references for cleanup
            window.currentNetworkSvg = svg;
            window.currentSimulation = simulation;

        } catch (error) {
            console.error('Error updating network visualization:', error);
            networkContainer.innerHTML = '<div class="text-center py-4 text-red-500">Error creating network visualization</div>';
        }
    }

    // Drag function for nodes
    function drag(simulation) {
        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            // Keep fixed position for user and group nodes
            if (d.id === "user" || d.isGroupNode) {
                return;
            }
            d.fx = null;
            d.fy = null;
        }
        
        return d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended);
    }

    // Helper function to extract industry from company or title
    function extractIndustry(company, title) {
        if (!company && !title) return "Unknown";
        
        const industries = [
            "Technology", "Finance", "Healthcare", "Education", 
            "Manufacturing", "Retail", "Media", "Legal", "Consulting",
            "Real Estate", "Construction", "Transportation", "Energy"
        ];
        
        const text = `${company || ""} ${title || ""}`.toLowerCase();
        
        // Check for industry keywords
        for (const industry of industries) {
            if (text.includes(industry.toLowerCase())) {
                return industry;
            }
        }
        
        // Default categorization based on common terms
        if (text.match(/tech|software|it|computer|data|digital|web|app|cloud/)) return "Technology";
        if (text.match(/bank|financ|invest|capital|asset|wealth|fund|insurance/)) return "Finance";
        if (text.match(/health|medical|hospital|clinic|pharma|doctor|care/)) return "Healthcare";
        if (text.match(/school|university|college|education|academic|teach/)) return "Education";
        if (text.match(/manufactur|product|factory|industrial/)) return "Manufacturing";
        if (text.match(/retail|shop|store|market|ecommerce|commerce/)) return "Retail";
        if (text.match(/media|news|publish|content|creative|design|market/)) return "Media";
        if (text.match(/law|legal|attorney|advocate|counsel/)) return "Legal";
        if (text.match(/consult|advisor|strategy/)) return "Consulting";
        
        return "Other";
    }

    // Helper function to extract location from address
    function extractLocation(address) {
        if (!address) return "Unknown";
        
        // Simple extraction of last part of address which is often city/state/country
        const parts = address.split(',');
        if (parts.length > 1) {
            return parts[parts.length - 1].trim();
        }
        
        return "Unknown";
    }

    // Function to toggle fullscreen network view
    function toggleFullscreenNetwork() {
        const container = document.getElementById('networkGraph').closest('.bg-white');
        
        function handleResize() {
            if (container.classList.contains('fullscreen')) {
                updateNetworkVisualization();
            }
        }
        
        if (container.classList.contains('fullscreen')) {
            // Exit fullscreen
            container.classList.remove('fullscreen');
            container.style.position = '';
            container.style.top = '';
            container.style.left = '';
            container.style.width = '';
            container.style.height = '';
            container.style.zIndex = '';
            
            // Remove event listener
            window.removeEventListener('resize', handleResize);
            
            // Resize visualization
            updateNetworkVisualization();
        } else {
            // Enter fullscreen
            container.classList.add('fullscreen');
            container.style.position = 'fixed';
            container.style.top = '0';
            container.style.left = '0';
            container.style.width = '100vw';
            container.style.height = '100vh';
            container.style.zIndex = '9999';
            
            // Add event listener
            window.addEventListener('resize', handleResize);
            
            // Resize visualization
            updateNetworkVisualization();
        }
    }

    // Function to update network analytics
    let isUpdatingAnalytics = false;
    function updateNetworkAnalytics(groupedContacts) {
        if (!contactsData || contactsData.length === 0) return;
        
        if (isUpdatingAnalytics) return;
        isUpdatingAnalytics = true;
        
        try {
            // Update dashboard metrics
            updateDashboardMetrics();
            
            // Update key insights
            updateKeyInsights(groupedContacts);
            
            // Update charts
            updateCompanyDistributionChart(groupedContacts);
            updateIndustryInsightsChart();
            
            // Update action items
            updateActionItems(groupedContacts);
        } finally {
            isUpdatingAnalytics = false;
        }
    }

    // Function to update dashboard metrics
    function updateDashboardMetrics() {
        // Total contacts
        const totalContacts = contactsData.length;
        document.getElementById('totalContactsCount').textContent = totalContacts;
        
        // Calculate growth based on dateAdded
        const now = new Date();
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const newContactsThisMonth = contactsData.filter(contact => {
            const dateAdded = new Date(contact.dateAdded || 0);
            return dateAdded >= lastMonth;
        }).length;
        
        // Calculate growth percentage
        const previousMonthContacts = totalContacts - newContactsThisMonth;
        const growthPercentage = previousMonthContacts > 0 
            ? Math.round((newContactsThisMonth / previousMonthContacts) * 100)
            : newContactsThisMonth > 0 ? 100 : 0;
        
        // Update growth metric
        const growthText = newContactsThisMonth > 0 
            ? `+${newContactsThisMonth} (${growthPercentage}%)`
            : '0%';
        document.getElementById('contactsGrowth').textContent = growthText + ' from last month';
        
        // Update industry filter options
        const uniqueIndustries = new Set(contactsData.map(c => c.industry).filter(Boolean));
        const industryFilter = document.getElementById('filterByIndustry');
        const currentValue = industryFilter.value;
        
        // Clear existing options except the first one
        while (industryFilter.options.length > 1) {
            industryFilter.remove(1);
        }
        
        // Add new options
        Array.from(uniqueIndustries).sort().forEach(industry => {
            const option = document.createElement('option');
            option.value = industry;
            option.textContent = industry;
            industryFilter.appendChild(option);
        });
        
        // Restore selected value if it still exists
        if (currentValue && uniqueIndustries.has(currentValue)) {
            industryFilter.value = currentValue;
        }

        updateTagFilterOptions();
        updateFollowUpHint();
        
        // Unique companies
        const uniqueCompanies = new Set(contactsData.filter(c => c.company).map(c => c.company)).size || 0;
        document.getElementById('uniqueCompaniesCount').textContent = uniqueCompanies;
        
        // Most common industry
        const industries = contactsData.map(c => c.industry || 'Other');
        const industryCounts = {};
        industries.forEach(i => {
            industryCounts[i] = (industryCounts[i] || 0) + 1;
        });
        
        let topIndustry = 'None';
        let topCount = 0;
        
        Object.entries(industryCounts).forEach(([industry, count]) => {
            if (count > topCount) {
                topIndustry = industry;
                topCount = count;
            }
        });
        
        document.getElementById('topIndustry').textContent = 'Most common: ' + topIndustry;
        
        // Connection strength (based on company diversity)
        let connectionStrength = 0;
        if (totalContacts > 0) {
            // Calculate as ratio of unique companies to contacts, scaled to 100
            connectionStrength = Math.min(Math.round((uniqueCompanies / totalContacts) * 100), 100);
        }
        document.getElementById('connectionStrength').textContent = connectionStrength + '%';
        
        // Add tooltip for connection strength
        const connectionStrengthElement = document.getElementById('connectionStrength').parentElement.parentElement;
        connectionStrengthElement.setAttribute('data-tooltip', 'Connection Strength measures how diverse your network is across companies. It\'s calculated as the percentage of unique companies relative to your total contacts. Higher scores indicate a more diverse network.');
        
        // Connection tip
        let connectionTip = 'Add more contacts to improve';
        if (connectionStrength < 30) {
            connectionTip = 'Try adding contacts from different companies';
        } else if (connectionStrength < 70) {
            connectionTip = 'Good diversity, keep expanding';
        } else {
            connectionTip = 'Excellent company diversity!';
        }
        document.getElementById('connectionTip').textContent = connectionTip;
        
        // Network reach (potential second-degree connections)
        // Simple estimate: each contact could introduce you to ~5 people
        const networkReach = totalContacts > 0 ? totalContacts * 5 : 0;
        document.getElementById('networkReach').textContent = networkReach;
        
        // Add tooltip for network reach
        const networkReachElement = document.getElementById('networkReach').parentElement.parentElement;
        networkReachElement.setAttribute('data-tooltip', 'Network Reach estimates your potential second-degree connections. It assumes each contact could introduce you to approximately 5 new people. This gives you an idea of how far your network could potentially extend.');
        
        document.getElementById('reachMetric').textContent = 'Potential connections';
    }

    // Function to update key insights
    function updateKeyInsights(groupedContacts) {
        const diversityScoreElement = document.getElementById('diversityScore');
        const connectionOpportunitiesElement = document.getElementById('connectionOpportunities');
        const networkingRecommendationElement = document.getElementById('networkingRecommendation');
        
        if (!contactsData || contactsData.length < 2) {
            diversityScoreElement.textContent = 'Add more contacts to see diversity score';
            connectionOpportunitiesElement.textContent = 'Add more contacts to see opportunities';
            networkingRecommendationElement.textContent = 'Add more contacts to get personalized recommendations';
            return;
        }

        // Calculate network diversity
        const companies = contactsData.filter(c => c.company).map(c => c.company);
        const uniqueCompanies = new Set(companies);
        const companyDiversity = companies.length > 0 ? uniqueCompanies.size / companies.length : 0;
        
        const industries = contactsData.map(c => c.industry || 'Other');
        const uniqueIndustries = new Set(industries);
        const industryDiversity = industries.length > 0 ? uniqueIndustries.size / industries.length : 0;
        
        // Calculate overall diversity score (weighted average)
        const diversityScore = Math.round(((companyDiversity * 0.6) + (industryDiversity * 0.4)) * 100);
        
        // Update diversity score insight
        let diversityText = '';
        if (diversityScore < 30) {
            diversityText = `Low diversity score (${diversityScore}%). Your network is concentrated in few companies/industries.`;
        } else if (diversityScore < 70) {
            diversityText = `Moderate diversity score (${diversityScore}%). You have a good balance of connections.`;
        } else {
            diversityText = `High diversity score (${diversityScore}%)! Your network spans many companies and industries.`;
        }
        diversityScoreElement.textContent = diversityText;
        
        // Add tooltip for diversity score
        const diversityScoreContainer = document.getElementById('diversityScore').parentElement;
        diversityScoreContainer.setAttribute('data-tooltip', 'Diversity Score is a comprehensive measure that considers both company and industry diversity. It\'s calculated as a weighted average: 60% based on company diversity and 40% based on industry diversity. A higher score indicates a well-rounded network.');
        
        // Connection opportunities
        let opportunitiesText = '';
        if (uniqueCompanies.size > 1) {
            // Find companies with multiple contacts
            const companyCounts = {};
            companies.forEach(company => {
                companyCounts[company] = (companyCounts[company] || 0) + 1;
            });
            
            const strongCompanies = Object.entries(companyCounts)
                .filter(([_, count]) => count > 1)
                .sort((a, b) => b[1] - a[1]);
            
            if (strongCompanies.length > 0) {
                const [topCompany, count] = strongCompanies[0];
                opportunitiesText = `You have ${count} contacts at ${topCompany}. This could be a strong connection point for new opportunities.`;
            } else {
                opportunitiesText = `You have contacts across ${uniqueCompanies.size} different companies. Consider deepening relationships at key organizations.`;
            }
        } else if (uniqueCompanies.size === 1) {
            opportunitiesText = `All your contacts are at ${Array.from(uniqueCompanies)[0]}. Consider expanding to other companies.`;
        } else {
            opportunitiesText = `Add company information to your contacts to see connection opportunities.`;
        }
        connectionOpportunitiesElement.textContent = opportunitiesText;
        
        // Networking recommendation
        let recommendationText = '';
        if (contactsData.length >= 5) {
            // Find most common industry
            const industryCounts = {};
            industries.forEach(industry => {
                industryCounts[industry] = (industryCounts[industry] || 0) + 1;
            });
            
            const sortedIndustries = Object.entries(industryCounts)
                .sort((a, b) => b[1] - a[1]);
            
            if (sortedIndustries.length > 0) {
                const [topIndustry, _] = sortedIndustries[0];
                
                if (industryDiversity < 0.3) {
                    recommendationText = `Your network is concentrated in ${topIndustry}. Consider expanding to related industries for more diverse opportunities.`;
                } else if (uniqueCompanies.size < 3) {
                    recommendationText = `Try connecting with more companies in the ${topIndustry} industry to strengthen your position.`;
                } else {
                    recommendationText = `You have a well-balanced network. Consider deepening relationships with key contacts.`;
                }
            } else {
                recommendationText = `Add industry information to your contacts to get personalized recommendations.`;
            }
        } else {
            recommendationText = `Add more contacts to get personalized recommendations.`;
        }
        networkingRecommendationElement.textContent = recommendationText;
    }

    // Function to update action items
    function updateActionItems(groupedContacts) {
        const actionItemsContainer = document.getElementById('actionItems');
        const customActionItem = document.getElementById('customActionItem');
        
        if (!contactsData || contactsData.length < 3) {
            // Keep default action items for small networks
            return;
        }
        
        // Get company and industry data
        const companies = contactsData.filter(c => c.company).map(c => c.company);
        const companyCounts = {};
        companies.forEach(company => {
            companyCounts[company] = (companyCounts[company] || 0) + 1;
        });
        
        // Sort companies by count
        const sortedCompanies = Object.entries(companyCounts)
            .sort((a, b) => b[1] - a[1]);
        
        // Update custom action item based on network analysis
        if (customActionItem) {
            const actionTitle = document.createElement('h4');
            actionTitle.className = 'font-medium';
            
            const actionDescription = document.createElement('p');
            actionDescription.className = 'text-sm text-gray-600 mt-1';
            
            if (sortedCompanies.length > 0) {
                const [topCompany, count] = sortedCompanies[0];
                
                if (count > 2) {
                    // If user has multiple contacts at the same company
                    actionTitle.textContent = `Leverage Your ${topCompany} Network`;
                    actionDescription.textContent = `You have ${count} contacts at ${topCompany}. Consider organizing a group meeting to strengthen these connections.`;
                } else if (sortedCompanies.length > 3) {
                    // If user has contacts across many companies
                    actionTitle.textContent = 'Cross-Company Introductions';
                    actionDescription.textContent = `You have contacts across ${sortedCompanies.length} companies. Consider making strategic introductions between them.`;
                } else {
                    // Default action
                    actionTitle.textContent = 'Organize Your Contacts';
                    actionDescription.textContent = 'Group your contacts by company or industry for better organization and follow-up.';
                }
            } else {
                // Default action
                actionTitle.textContent = 'Add Company Information';
                actionDescription.textContent = 'Update your contacts with company information to get more personalized action items.';
            }
            
            // Clear previous content and add new content
            const actionContent = customActionItem.querySelector('div:last-child');
            if (actionContent) {
                actionContent.innerHTML = '';
                actionContent.appendChild(actionTitle);
                actionContent.appendChild(actionDescription);
            }
        }
    }

    // Function to update company distribution chart
    function updateCompanyDistributionChart(groupedContacts) {
        // Get the container element
        const companyChartContainer = document.getElementById('companyDistributionChart');
        const topCompaniesContainer = document.getElementById('topCompanies');
        
        if (!companyChartContainer) {
            console.error('Company chart container not found');
            return;
        }

        try {
            // Safely destroy existing chart if it exists
            if (window.companyDistributionChart) {
                try {
                    window.companyDistributionChart.destroy();
                } catch (e) {
                    console.log('Error destroying company chart:', e);
                }
                window.companyDistributionChart = null;
            }
            
            // If we don't have enough data, show a message instead (consistent with network visualization)
            if (contactsData.length < 2) {
                companyChartContainer.innerHTML = `
                    <div class="flex items-center justify-center h-64 text-gray-500">
                        Add at least 2 contacts to see company distribution
                    </div>
                `;
                
                // Also update the companies list
                if (topCompaniesContainer) {
                    topCompaniesContainer.innerHTML = 
                        '<div class="text-center py-4 text-gray-500">Add at least 2 contacts to see company information</div>';
                }
                
                return;
            }

            // Clear the container and create a new canvas element
            companyChartContainer.innerHTML = '';
            const canvas = document.createElement('canvas');
            canvas.id = 'companyDistChart';
            canvas.width = companyChartContainer.clientWidth || 300;
            canvas.height = companyChartContainer.clientHeight || 200;
            companyChartContainer.appendChild(canvas);
            
            // Get the 2D context from the new canvas
            const ctx = canvas.getContext('2d');
            
            // Get company counts
            const companies = contactsData
                .filter(c => c.company)
                .map(c => c.company.trim());
            
            if (companies.length < 2) {
                // Show message in HTML instead of canvas
                companyChartContainer.innerHTML = `
                    <div class="flex items-center justify-center h-64 text-gray-500">
                        Add more contacts with company information
                    </div>
                `;
                
                // Also update the companies list
                if (topCompaniesContainer) {
                    topCompaniesContainer.innerHTML = 
                        '<div class="text-center py-4 text-gray-500">Add more contacts with company information</div>';
                }
                
                return;
            }

            const companyCounts = {};
            companies.forEach(company => {
                companyCounts[company] = (companyCounts[company] || 0) + 1;
            });
            
            // Sort companies by count
            const sortedCompanies = Object.entries(companyCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5); // Top 5 companies
            
            // Prepare chart data
            const chartData = {
                labels: sortedCompanies.map(([company]) => company),
                datasets: [{
                    label: 'Contacts',
                    data: sortedCompanies.map(([_, count]) => count),
                    backgroundColor: [
                        'rgba(54, 162, 235, 0.6)',
                        'rgba(255, 99, 132, 0.6)',
                        'rgba(255, 206, 86, 0.6)',
                        'rgba(75, 192, 192, 0.6)',
                        'rgba(153, 102, 255, 0.6)'
                    ],
                    borderColor: [
                        'rgba(54, 162, 235, 1)',
                        'rgba(255, 99, 132, 1)',
                        'rgba(255, 206, 86, 1)',
                        'rgba(75, 192, 192, 1)',
                        'rgba(153, 102, 255, 1)'
                    ],
                    borderWidth: 1
                }]
            };
            
            // Check that Chart constructor exists
            if (typeof Chart === 'undefined') {
                console.error('Chart.js is not loaded');
                companyChartContainer.innerHTML = `
                    <div class="flex items-center justify-center h-64 text-red-500">
                        Chart library not available
                    </div>
                `;
                return;
            }
            
            // Create new chart instance
            window.companyDistributionChart = new Chart(ctx, {
                type: 'bar',
                data: chartData,
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                precision: 0
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                title: function(tooltipItems) {
                                    return tooltipItems[0].label;
                                },
                                label: function(context) {
                                    return `${context.parsed.y} contact${context.parsed.y !== 1 ? 's' : ''}`;
                                }
                            }
                        }
                    }
                }
            });
            
            // Update top companies list if the container exists
            if (topCompaniesContainer) {
                topCompaniesContainer.innerHTML = '';
                
                if (sortedCompanies.length === 0) {
                    topCompaniesContainer.innerHTML = '<div class="text-center py-4 text-gray-500">No company data available</div>';
                    return;
                }
                
                // Add a header for the list
                const header = document.createElement('div');
                header.className = 'font-medium text-gray-700 mb-2';
                header.textContent = 'Top Companies';
                topCompaniesContainer.appendChild(header);
                
                // Create a container for the company list
                const listContainer = document.createElement('div');
                listContainer.className = 'space-y-2 max-h-40 overflow-y-auto pr-2';
                topCompaniesContainer.appendChild(listContainer);
                
                sortedCompanies.forEach(([company, count], index) => {
                    const percentage = Math.round((count / companies.length) * 100);
                    const item = document.createElement('div');
                    item.className = 'flex items-center justify-between p-2 bg-gray-50 rounded-md';
                    item.innerHTML = `
                        <div class="flex items-center">
                            <div class="w-3 h-3 rounded-full mr-2" style="background-color: ${chartData.datasets[0].backgroundColor[index]}"></div>
                            <span class="font-medium">${company}</span>
                        </div>
                        <div class="flex items-center">
                            <span class="mr-2">${count} contact${count !== 1 ? 's' : ''}</span>
                            <span class="text-gray-500 text-sm">(${percentage}%)</span>
                        </div>
                    `;
                    listContainer.appendChild(item);
                });
                
                // Add a note about what this means
                const note = document.createElement('div');
                note.className = 'text-sm text-gray-600 mt-3';
                note.innerHTML = `<span class="font-medium">Insight:</span> ${sortedCompanies[0][0]} represents ${Math.round((sortedCompanies[0][1] / companies.length) * 100)}% of your network.`;
                topCompaniesContainer.appendChild(note);
            }
        } catch (error) {
            console.error('Error updating company distribution chart:', error);
            // Show error message on the container element
            companyChartContainer.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-red-500">Error updating chart</p></div>';
        }
    }

    // Function to update industry insights chart
    function updateIndustryInsightsChart() {
        // Get the container element
        const industryChartContainer = document.getElementById('industryInsightsChart');
        const clusterStatsContainer = document.getElementById('clusterStats');
        
        if (!industryChartContainer) {
            console.error('Industry chart container not found');
            return;
        }

        try {
            // Safely destroy existing chart if it exists
            if (window.industryInsightsChart) {
                try {
                    window.industryInsightsChart.destroy();
                } catch (e) {
                    console.log('Error destroying industry chart:', e);
                }
                window.industryInsightsChart = null;
            }
            
            // If we don't have enough data, show a message instead (consistent with network visualization)
            if (contactsData.length < 2) {
                industryChartContainer.innerHTML = `
                    <div class="flex items-center justify-center h-64 text-gray-500">
                        Add at least 2 contacts to see industry insights
                    </div>
                `;
                
                // Also update the industry stats
                if (clusterStatsContainer) {
                    clusterStatsContainer.innerHTML = 
                        '<div class="text-center py-4 text-gray-500">Add at least 2 contacts to see industry information</div>';
                               }
                
                return;
            }

            // Clear the container and create a new canvas element
            industryChartContainer.innerHTML = '';
            const canvas = document.createElement('canvas');
            canvas.id = 'industryDistChart';
            canvas.width = industryChartContainer.clientWidth || 300;
            canvas.height = industryChartContainer.clientHeight || 200;
            industryChartContainer.appendChild(canvas);
            
            // Get the 2D context from the new canvas
            const ctx = canvas.getContext('2d');
            
            // Extract industries from contacts
            const industries = contactsData.map(contact => 
                contact.industry || "Unknown"
            );
            
            // Count industries
            const industryCounts = {};
            industries.forEach(industry => {
                industryCounts[industry] = (industryCounts[industry] || 0) + 1;
            });
            
            // Sort industries by count
            const sortedIndustries = Object.entries(industryCounts)
                .sort((a, b) => b[1] - a[1]);
            
            // Prepare chart data
            const chartData = {
                               labels: sortedIndustries.map(([industry]) => industry),
                datasets: [{
                    label: 'Contacts',
                    data: sortedIndustries.map(([_, count]) => count),
                    backgroundColor: [
                        'rgba(255, 99, 132, 0.6)',
                        'rgba(54, 162, 235, 0.6)',
                        'rgba(255, 206, 86, 0.6)',
                        'rgba(75, 192, 192, 0.6)',
                        'rgba(153, 102, 255, 0.6)',
                        'rgba(255, 159, 64, 0.6)',
                        'rgba(199, 199, 199, 0.6)'
                    ],
                    borderColor: [
                        'rgba(255, 99, 132, 1)',
                        'rgba(54, 162, 235, 1)',
                        'rgba(255, 206, 86, 1)',
                        'rgba(75, 192, 192, 1)',
                        'rgba(153, 102, 255, 1)',
                        'rgba(255, 159, 64, 1)',
                        'rgba(199, 199, 199, 1)'
                    ],
                    borderWidth: 1
                }]
            };
            
            // Check that Chart constructor exists
            if (typeof Chart === 'undefined') {
                console.error('Chart.js is not loaded');
                industryChartContainer.innerHTML = `
                    <div class="flex items-center justify-center h-64 text-red-500">
                        Chart library not available

                    </div>
                `;
                return;
            }
            
            // Create new chart instance
            window.industryInsightsChart = new Chart(ctx, {
                type: 'pie',
                data: chartData,
                options: {
                    responsive: true,
                    maintainAspectRatio: false,

                    plugins: {
                        legend: {
                            position: 'right',
                            labels: {
                                boxWidth: 12,
                                font: {
                                    size: 10
                                }
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const label = context.label || '';
                                    const value = context.parsed || 0;
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const percentage = Math.round((value / total) * 100);
                                    return `${label}: ${value} contacts (${percentage}%)`;
                                }
                            }
                        }
                    }
                }
            });
            
            // Update industry stats
            if (clusterStatsContainer) {
                clusterStatsContainer.innerHTML = '';
                
                // Add a header
                const header = document.createElement('div');
                header.className = 'font-medium text-gray-700 mb-2';
                header.textContent = 'Industry Distribution';
                clusterStatsContainer.appendChild(header);
                
                // Create a table for the industry stats
                const table = document.createElement('table');
                table.className = 'min-w-full divide-y divide-gray-200';
                
                // Create table header
                const thead = document.createElement('thead');
                thead.className = 'bg-gray-50';
                thead.innerHTML = `
                    <tr>
                        <th scope="col" class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Industry</th>
                        <th scope="col" class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Contacts</th>
                        <th scope="col" class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">%</th>
                    </tr>
                `;
                table.appendChild(thead);
                
                // Create table body
                const tbody = document.createElement('tbody');
                tbody.className = 'bg-white divide-y divide-gray-200';
                
                const total = industries.length;
                sortedIndustries.forEach(([industry, count], index) => {
                    const percentage = Math.round((count / total) * 100);
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td class="px-3 py-2 whitespace-nowrap text-sm font-medium text-gray-900">${industry}</td>
                        <td class="px-3 py-2 whitespace-nowrap text-sm text-gray-500">${count}</td>
                        <td class="px-3 py-2 whitespace-nowrap text-sm text-gray-500">${percentage}%</td>
                    `;
                    tbody.appendChild(row);
                });
                
                table.appendChild(tbody);
                clusterStatsContainer.appendChild(table);
                
                // Add insight
                const insight = document.createElement('div');
                insight.className = 'text-sm text-gray-600 mt-3';
                
                if (sortedIndustries.length > 1) {
                    const primaryIndustry = sortedIndustries[0][0];
                    const primaryPercentage = Math.round((sortedIndustries[0][1] / total) * 100);
                    const secondaryIndustry = sortedIndustries[1][0];
                    
                    insight.innerHTML = `<span class="font-medium">Insight:</span> Your network is primarily in ${primaryIndustry} (${primaryPercentage}%), with ${secondaryIndustry} as a secondary focus.`;
                } else if (sortedIndustries.length === 1) {
                    insight.innerHTML = `<span class="font-medium">Insight:</span> Your network is entirely focused on the ${sortedIndustries[0][0]} industry.`;
                }
                
                clusterStatsContainer.appendChild(insight);
            }
        } catch (error) {
            console.error('Error updating industry insights chart:', error);
            // Show error message on the container element
            industryChartContainer.innerHTML = '<div class="flex items-center justify-center h-full"><p class="text-red-500">Error updating chart</p></div>';
        }
    }

    // Helper function to update all visualizations and data displays
    function refreshAllVisualizations() {
        try {
            // Update contact list UI
            filterAndSortContacts();
            
            // Force immediate chart refreshs
            if (window.companyDistributionChart) {
                try {
                    window.companyDistributionChart.destroy();
                } catch (e) {
                    console.log('Error destroying company chart:', e);
                }
                window.companyDistributionChart = null;
            }
            
            if (window.industryInsightsChart) {
                try {
                    window.industryInsightsChart.destroy();
                } catch (e) {
                    console.log('Error destroying industry chart:', e);
                }
                window.industryInsightsChart = null;
            }
            
            // Update network components if we're on the network tab
            if (!networkContent.classList.contains('hidden')) {
                // Force stop any existing simulations
                if (window.currentSimulation) {
                    try {
                        window.currentSimulation.stop();
                    } catch (e) {
                        console.log('Error stopping simulation:', e);
                    }
                }
                
                try {
                    // Update the network visualization with fresh data
                    updateNetworkVisualization();
                } catch (error) {
                    console.error('Error updating network visualizations:', error);
                }
            }
            
            // Update dashboard metrics regardless of current tab
            try {
                updateDashboardMetrics();
            } catch (error) {
                console.error('Error updating dashboard metrics:', error);
            }
            
            // Explicitly update charts after a short delay
            setTimeout(() => {
                try {
                    updateCompanyDistributionChart();
                    updateIndustryInsightsChart();
                } catch (chartError) {
                    console.error('Error updating charts:', chartError);
                }
            }, 100);
        } catch (error) {
            console.error('Error refreshing visualizations:', error);
        }
    }

    // Initialize the application
    async function initializeApp() {
        if (initializeAppPromise) return initializeAppPromise;
        initializeAppPromise = (async () => {
            try {
                setBootStatus(hasStoredSessionHint()
                    ? 'Restoring your session…'
                    : 'Preparing Folio…');

                // Optimistic restore from local cache so refresh never flashes the login screen.
                const cachedUser = readCachedAuthUser();
                const cachedToken = getAuthToken();
                if (cachedUser?.id && cachedToken) {
                    applyAuthUser(cachedUser, cachedToken);
                    hideSignInModal();
                    signOutBtn?.classList.remove('hidden');
                    scanTab?.classList.add('tab-active');
                    scanContent?.classList.remove('hidden');
                }

                const authenticated = await isAuthenticated();
                setupGoogleSignIn();

                if (authenticated) {
                    signOutBtn.classList.remove('hidden');
                    hideSignInModal();
                    scanTab.classList.add('tab-active');
                    scanContent.classList.remove('hidden');
                    setBootStatus('Welcome back');
                    loadContacts()
                        .then(() => restoreContactAfterPhoneSave())
                        .catch((error) => {
                            console.error('Error loading contacts during initialization:', error);
                        });
                } else {
                    setBootStatus('Ready to sign in');
                    showSignInModal();
                }
            } catch (error) {
                console.error('Error during initialization:', error);
                if (!userId) showSignInModal();
            } finally {
                authReady = true;
                dismissBootSplash();
            }
        })();
        return initializeAppPromise;
    }

    // Initialize the app when DOM is loaded
    initializeApp();

    // Delete All Modal Event Listeners
    deleteAllBtn.addEventListener('click', () => {
        deleteAllModal.classList.remove('hidden');
    });

    cancelDeleteAllBtn.addEventListener('click', () => {
        deleteAllModal.classList.add('hidden');
    });

    // Update confirmDeleteAllBtn click handler
    confirmDeleteAllBtn.addEventListener('click', async () => {
        if (!userId) {
            console.error('No userId available');
            showToast('Please sign in to delete contacts', 'error');
            return;
        }

        try {
            const response = await fetch(`${API_URL}/contacts`, {
                method: 'DELETE',
                headers: authHeaders(),
                body: JSON.stringify({ userId: userId })
            });
                    
            if (!response.ok) {
                throw new Error('Failed to delete all contacts');
            }

            const result = await response.json();
            console.log('Delete All Response:', result);

            // Clear local contacts data
            contactsData = [];
            await cacheContactsSnapshot([]);
            
            // Update UI and visualizations
            refreshAllVisualizations();
            
            // Force update network charts
            if (!networkContent.classList.contains('hidden')) {
                // Force recreation of charts
                updateCompanyDistributionChart();
                updateIndustryInsightsChart();
            }
            
            // Hide modal
            deleteAllModal.classList.add('hidden');

            showToast('All contacts deleted successfully', 'success');
        } catch (error) {
            console.error('Error deleting all contacts:', error);
            showToast('Failed to delete all contacts', 'error');
        }
    });

    // Add delete confirmation modal HTML after the deleteAllModal
    const deleteContactModal = document.createElement('div');
    deleteContactModal.id = 'deleteContactModal';
    deleteContactModal.className = 'modal-overlay hidden';
    deleteContactModal.innerHTML = `
        <div class="modal-content sheet">
            <div class="sheet-body" style="text-align:center;">
                <h3 style="margin-bottom:8px;">Delete Contact</h3>
                <p style="color:var(--muted);margin:0 0 20px;">Are you sure you want to delete this contact? This cannot be undone.</p>
                <div style="display:flex;gap:10px;">
                    <button id="cancelDeleteContact" class="btn-secondary" style="flex:1;" type="button">Cancel</button>
                    <button id="confirmDeleteContact" class="btn-luxury btn-luxury--danger" style="flex:1.2;" type="button">
                        <span class="btn-luxury__disc">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        </span>
                        <span>Delete</span>
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(deleteContactModal);

    // Add event listeners for delete contact modal
    document.getElementById('confirmDeleteContact').addEventListener('click', async () => {
        const cardId = deleteContactModal.dataset.cardId;
        if (!cardId) return;

        try {
            const response = await fetch(`${API_URL}/contacts/${cardId}?userId=${encodeURIComponent(userId)}`, {
                method: 'DELETE',
                headers: authHeaders(),
            });

            if (!response.ok) {
                throw new Error('Failed to delete contact');
            }

            // Update local data immediately
            contactsData = contactsData.filter(contact => contact.cardId !== cardId);
            
            // Hide modal first for better responsiveness
            deleteContactModal.classList.add('hidden');
            
            // Show toast to provide feedback
            showToast('Contact deleted successfully', 'success');
            
            // Force immediate refresh of all visualizations
            // First destroy existing charts
            if (window.companyDistributionChart) {
                try {
                    window.companyDistributionChart.destroy();
                } catch (e) {
                    console.log('Error destroying company chart during deletion:', e);
                }
                window.companyDistributionChart = null;
            }
            
            if (window.industryInsightsChart) {
                try {
                    window.industryInsightsChart.destroy();
                } catch (e) {
                    console.log('Error destroying industry chart during deletion:', e);
                }
                window.industryInsightsChart = null;
            }
            
            // Now update the UI
            filterAndSortContacts();
            updateDashboardMetrics();
            
            // Update network visualization and all charts
            updateNetworkVisualization();
            
            // Explicitly recreate charts after DOM updates
            setTimeout(() => {
                try {
                    updateCompanyDistributionChart();
                    updateIndustryInsightsChart();
                } catch (chartError) {
                    console.error('Error updating charts after deletion:', chartError);
                }
            }, 100);
            
        } catch (error) {
            console.error('Error deleting contact:', error);
            showToast('Failed to delete contact', 'error');
            deleteContactModal.classList.add('hidden');
        }
    });

    document.getElementById('cancelDeleteContact').addEventListener('click', () => {
        deleteContactModal.classList.add('hidden');
    });

    // Download All Button Event Listener
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', () => {
            if (!contactsData.length) {
                showToast('No contacts to export', 'warning');
                return;
            }
            exportContactsCsv(contactsData);
            showToast('CSV exported', 'success');
        });
    }

    document.getElementById('downloadAllBtn').addEventListener('click', async () => {
        if (!userId) {
            showToast('Please sign in to download contacts', 'error');
            return;
        }

        try {
            // Create a zip file containing all vCards
            const zip = new JSZip();
            
            // Add each contact's vCard to the zip
            for (const contact of contactsData) {
                const response = await fetch(`${API_URL}/vcard/${contact.cardId}?userId=${encodeURIComponent(userId)}`, {
                headers: authHeaders(),
            });
                if (!response.ok) throw new Error(`Failed to download vCard for ${contact.name}`);
                
                const vcardContent = await response.text();
                const filename = `${contact.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.vcf`;
                zip.file(filename, vcardContent);
            }
            
            // Generate and download the zip file
            const content = await zip.generateAsync({type: 'blob'});
            const url = window.URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'contacts.zip';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            
            showToast('Successfully downloaded all contacts', 'success');
        } catch (error) {
            console.error('Error downloading contacts:', error);
            showToast('Failed to download contacts', 'error');
        }
    });

    // Make necessary variables and functions available globally
    window.userId = userId;
    window.contactsData = contactsData;
    window.API_URL = API_URL;
    window.filterAndSortContacts = filterAndSortContacts;
    window.showToast = showToast;
    window.deleteContact = deleteContact;
    window.showEditContactModal = showEditContactModal;
    window.openContactDetail = openContactDetail;

    // Update sign-in form submission
    signInModeToggle?.addEventListener('click', () => {
        setSignInMode(!signInIsRegister);
    });

    signInForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const submitBtn = signInForm.querySelector('button[type="submit"]');

        if (!username || !password) {
            signInError.textContent = 'Please enter both username and password';
            signInError.classList.remove('hidden');
            return;
        }

        try {
            if (submitBtn) submitBtn.disabled = true;
            showAuthLoading(
                signInIsRegister ? 'Creating your account…' : 'Signing you in…',
                'Hang tight — this can take a few seconds.'
            );
            const path = signInIsRegister ? '/auth/register' : '/auth/login';
            const response = await fetch(`${API_URL}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username, password }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Failed to sign in');
            }
            finishAuthenticatedSession(
                data.user,
                data.token,
                signInIsRegister ? 'Account created' : 'Signed in'
            );
        } catch (error) {
            console.error('Authentication error:', error);
            hideAuthLoading();
            signInError.textContent = error.message || 'Failed to sign in. Please check your credentials.';
            signInError.classList.remove('hidden');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });

    signOutBtn.addEventListener('click', async () => {
        showAuthLoading('Signing you out…', 'Clearing this device session.');
        try {
            await fetch(`${API_URL}/auth/logout`, {
                method: 'POST',
                headers: authHeaders(),
                credentials: 'include',
            });
        } catch (err) { /* ignore */ }
        clearAuthSession();
        hideAuthLoading();
        showSignInModal();
        switchToTab('scan');
    });

    // Process files in batches with concurrency control
    async function processBatch(files, startIndex, batchSize, concurrencyLimit, progressCallback) {
        const batch = Array.from(files).slice(startIndex, startIndex + batchSize);
        const results = [];
        const inProgress = new Set();

        async function processFile(file, index) {
            try {
                // Update status to "Processing..."
                updateThumbnailStatus(startIndex + index, null, "Processing...");
                
                // Process the file
                console.log(`Starting to process file ${startIndex + index}`);
                const result = await processBusinessCardFile(file);
                results[index] = { success: true, result };

                const newContacts = result?.contacts || (Array.isArray(result) ? result : []);
                warnIfDuplicates(newContacts);
                
                // Update UI immediately after API response
                console.log(`API success for file ${startIndex + index}`);
                updateThumbnailStatus(startIndex + index, true);
                
                // Call progress callback for individual file completion
                if (progressCallback) progressCallback(true);
            } catch (error) {
                console.error(`Error processing file ${startIndex + index}:`, error);
                results[index] = { success: false, error };
                
                // Update UI immediately on failure
                updateThumbnailStatus(startIndex + index, false);
                
                // Call progress callback for individual file completion (failure)
                if (progressCallback) progressCallback(false);
            } finally {
                inProgress.delete(index);
            }
        }

        const processNext = async () => {
            for (let i = 0; i < batch.length; i++) {
                if (!inProgress.has(i) && !results[i]) {
                    inProgress.add(i);
                    processFile(batch[i], i);

                    // Wait if we've hit the concurrency limit
                    if (inProgress.size >= concurrencyLimit) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
            }
        };

        // Start initial batch of concurrent operations
        await processNext();

        // Wait for all operations to complete
        while (inProgress.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return results;
    }

    // Create upload confirmation modal
    const uploadConfirmModal = document.createElement('div');
    uploadConfirmModal.id = 'uploadConfirmModal';
    uploadConfirmModal.className = 'fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full hidden z-50';
    uploadConfirmModal.innerHTML = `
        <div class="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div class="mt-3 text-center">
                <div class="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-yellow-100">
                    <svg class="h-6 w-6 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                </div>
                <h3 class="text-lg leading-6 font-medium text-gray-900 mt-4">Large Upload Warning</h3>
                <div class="mt-2 px-7 py-3">
                    <p class="text-sm text-gray-500" id="uploadConfirmMessage"></p>
                </div>
                <div class="items-center px-4 py-3">
                    <button id="confirmUpload" class="px-4 py-2 bg-yellow-600 text-white text-base font-medium rounded-md w-full shadow-sm hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-yellow-500">
                        Continue Upload
                    </button>
                    <button id="cancelUpload" class="mt-3 px-4 py-2 bg-gray-100 text-gray-700 text-base font-medium rounded-md w-full shadow-sm hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500">
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(uploadConfirmModal);

    let pendingFrontUpload = null;

    function askCardSidesChoice({ title, message, primary, secondary }) {
        const modal = document.getElementById('cardSidesModal');
        if (!modal) return Promise.resolve(false);
        document.getElementById('cardSidesTitle').textContent = title;
        document.getElementById('cardSidesMessage').textContent = message;
        document.getElementById('cardSidesPrimaryLabel').textContent = primary;
        document.getElementById('cardSidesSecondaryBtn').textContent = secondary;
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        return new Promise((resolve) => {
            const primaryBtn = document.getElementById('cardSidesPrimaryBtn');
            const secondaryBtn = document.getElementById('cardSidesSecondaryBtn');
            const closeBtn = document.getElementById('closeCardSidesModal');
            const finish = (value) => {
                modal.classList.add('hidden');
                document.body.style.overflow = '';
                primaryBtn.removeEventListener('click', onPrimary);
                secondaryBtn.removeEventListener('click', onSecondary);
                closeBtn.removeEventListener('click', onSecondary);
                modal.removeEventListener('click', onBackdrop);
                resolve(value);
            };
            const onPrimary = () => finish(true);
            const onSecondary = () => finish(false);
            const onBackdrop = (event) => {
                if (event.target === modal) finish(false);
            };
            primaryBtn.addEventListener('click', onPrimary);
            secondaryBtn.addEventListener('click', onSecondary);
            closeBtn.addEventListener('click', onSecondary);
            modal.addEventListener('click', onBackdrop);
        });
    }

    async function ingestPairedSides(frontFile, backFile, options = {}) {
        let front = frontFile;
        let back = backFile;
        if (!options.alreadyCropped) {
            if (front) {
                front = await cropAndConfirm(front, 'front');
                if (!front) return;
            }
            if (back) {
                back = await cropAndConfirm(back, 'back');
                if (!back) return;
            }
        }
        const sides = [front, back].filter(Boolean);
        if (!sides.length) return;
        if (processingStatus) processingStatus.textContent = sides.length > 1 ? 'Reading both sides…' : 'Reading card text…';
        setScanProcessing(true, 'Reading your card', sides.length > 1 ? 'Front and back together' : 'This usually takes a few seconds');
        resetBtn.classList.add('hidden');
        uploadProgress.textContent = '';
        thumbnailGallery.innerHTML = '';
        setUploadShimmer(true);
        sides.forEach((file, index) => {
            createThumbnailElement(file, index, null, sides.length > 1 ? (index === 0 ? 'Front' : 'Back') : '');
        });
        try {
            const result = await processBusinessCardSides(sides);
            const ok = !!(result?.contacts?.length);
            sides.forEach((_, index) => updateThumbnailStatus(index, ok));
            if (ok) {
                scanCompleteMessage.classList.remove('hidden');
                scanCompleteMessage.classList.add('success-banner');
                celebrateScanSuccess();
                const saved = normalizeSavedCard(result.contacts[0]);
                await loadContacts();
                refreshAllVisualizations();
                const fresh = contactsData.find((c) => c.cardId === saved.cardId) || saved;
                openScanReview({
                    ...fresh,
                    originalImageUrl: saved.originalImageUrl || fresh.originalImageUrl,
                    originalBackImageUrl: saved.originalBackImageUrl || fresh.originalBackImageUrl,
                    frontImage: saved.frontImage || fresh.frontImage,
                    backImage: saved.backImage || fresh.backImage,
                    cachedImageUrl: saved.originalImageUrl || fresh.cachedImageUrl,
                });
            } else {
                showToast('Could not save this card', 'error');
            }
        } catch (error) {
            console.error('Error processing card sides:', error);
            sides.forEach((_, index) => updateThumbnailStatus(index, false));
            showToast(error.message || 'Failed to process this card', 'error');
        } finally {
            setScanProcessing(false);
            setUploadShimmer(false);
            if (processingStatus) processingStatus.textContent = '';
            uploadProgress.textContent = '';
            if (fileUpload) fileUpload.value = '';
            const backInput = document.getElementById('fileUploadBack');
            if (backInput) backInput.value = '';
        }
    }

    // Shared ingest path for library uploads, drag-drop, and live camera captures
    async function ingestImageFiles(fileList, options = {}) {
        if (!await isAuthenticated()) {
            showToast('Please sign in to upload files', 'error');
            return;
        }

        const files = Array.from(fileList || []).filter((file) => file && String(file.type || '').startsWith('image/'));
        if (!files.length) {
            showToast('Please select at least one image file');
            return;
        }

        if (options.pairSides) {
            await ingestPairedSides(files[0], files[1], { alreadyCropped: options.alreadyCropped });
            return;
        }

        if (pendingFrontUpload && files.length === 1 && !options.skipPairPrompt) {
            const front = pendingFrontUpload;
            pendingFrontUpload = null;
            await ingestPairedSides(front, files[0]);
            return;
        }

        if (!options.skipPairPrompt && files.length === 1) {
            const addBack = await askCardSidesChoice({
                title: 'Add the other side?',
                message: 'If a number, email, or address is on the back, add that photo too. We will save both sides as one contact.',
                primary: 'Add the other side',
                secondary: 'This side only',
            });
            if (addBack) {
                pendingFrontUpload = files[0];
                showToast('Choose the back of the card');
                document.getElementById('fileUploadBack')?.click();
                return;
            }
        } else if (!options.skipPairPrompt && files.length === 2) {
            const pair = await askCardSidesChoice({
                title: 'Same card?',
                message: 'Save these as the front and back of one contact, or as two separate contacts.',
                primary: 'Front and back of one card',
                secondary: 'Two different cards',
            });
            if (pair) {
                await ingestPairedSides(files[0], files[1]);
                return;
            }
        }

        if (files.length === 1) {
            await ingestPairedSides(files[0], null, { alreadyCropped: options.alreadyCropped });
            return;
        }

        // Maximum number of files allowed to upload at once
        const MAX_FILES_ALLOWED = 10;
        
        // Enforce maximum file limit
        if (files.length > MAX_FILES_ALLOWED) {
            showToast(`You can only upload up to ${MAX_FILES_ALLOWED} files at once. Please reduce the number of files.`, 'error');
            // Reset the file input to clear the selection
            fileUpload.value = '';
            return;
        }

        // Show warning for large uploads
        if (files.length > 30) {
            // Update modal message
            const uploadConfirmMessage = document.getElementById('uploadConfirmMessage');
            uploadConfirmMessage.textContent = `You are about to upload ${files.length} files. This may take some time. Would you like to continue?`;
            
            // Show the modal
            const uploadConfirmModal = document.getElementById('uploadConfirmModal');
            uploadConfirmModal.classList.remove('hidden');

            // Return a promise that resolves when the user makes a choice
            const userChoice = await new Promise((resolve) => {
                const confirmUpload = document.getElementById('confirmUpload');
                const cancelUpload = document.getElementById('cancelUpload');

                const handleConfirm = () => {
                    cleanup();
                    resolve(true);
                };

                const handleCancel = () => {
                    cleanup();
                    resolve(false);
                };

                const cleanup = () => {
                    confirmUpload.removeEventListener('click', handleConfirm);
                    cancelUpload.removeEventListener('click', handleCancel);
                    uploadConfirmModal.classList.add('hidden');
                };

                confirmUpload.addEventListener('click', handleConfirm);
                cancelUpload.addEventListener('click', handleCancel);
            });

            if (!userChoice) {
                // User cancelled the upload
                fileUpload.value = '';
                return;
            }
        }

        // Initialize UI
        if (processingStatus) processingStatus.textContent = 'Preparing to process images...';
        setScanProcessing(true, 'Reading your cards', `Preparing ${files.length} images`);
        resetBtn.classList.add('hidden');
        uploadProgress.textContent = '';
        thumbnailGallery.innerHTML = ''; // Clear existing thumbnails
        setUploadShimmer(true);

        // Create progress tracking elements
        const progressContainer = document.createElement('div');
        progressContainer.className = 'panel';
        progressContainer.style.marginTop = '16px';
        progressContainer.innerHTML = `
            <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:0.9rem;font-weight:600;">
                <span>Progress</span>
                <span id="progressText" style="color:var(--muted);font-weight:500;">0/${files.length}</span>
            </div>
            <div style="width:100%;background:var(--bg-deep);border-radius:999px;height:8px;overflow:hidden;">
                <div id="progressBar" style="width:0%;height:100%;background:var(--copper);border-radius:999px;transition:width 0.25s ease;"></div>
            </div>
            <div style="margin-top:10px;display:flex;justify-content:space-between;font-size:0.85rem;">
                <span id="successCount" style="color:var(--success);">Successful: 0</span>
                <span id="failureCount" style="color:var(--danger);">Failed: 0</span>
            </div>
        `;
        uploadProgress.parentNode.insertBefore(progressContainer, uploadProgress.nextSibling);

        const progressBar = document.getElementById('progressBar');
        const progressText = document.getElementById('progressText');
        const successCount = document.getElementById('successCount');
        const failureCount = document.getElementById('failureCount');

        try {
            // Configuration
            const BATCH_SIZE = 10; // Process 10 files at a time
            const CONCURRENCY_LIMIT = 5; // Process 3 files concurrently
            let totalProcessed = 0;
            let totalSuccess = 0;
            let totalFailed = 0;

            // Create a callback function to update progress for each individual file
            const updateFileProgress = (isSuccess) => {
                totalProcessed++;
                if (isSuccess) {
                    totalSuccess++;
                } else {
                    totalFailed++;
                }

                // Update UI for each file completion
                const progress = (totalProcessed / files.length) * 100;
                progressBar.style.width = `${progress}%`;
                progressText.textContent = `${totalProcessed}/${files.length}`;
                successCount.textContent = `Successful: ${totalSuccess}`;
                failureCount.textContent = `Failed: ${totalFailed}`;
            };

            // Create thumbnails for all files before processing starts
            Array.from(files).forEach((file, index) => {
                createThumbnailElement(file, index, null); // null means "pending"
            });

            // Process all files in batches
            for (let startIndex = 0; startIndex < files.length; startIndex += BATCH_SIZE) {
                const batchResults = await processBatch(
                    files, 
                    startIndex, 
                    BATCH_SIZE, 
                    CONCURRENCY_LIMIT,
                    updateFileProgress
                );
                
                // Allow UI to update
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            // Final status update
            if (processingStatus) {
                processingStatus.textContent = `Completed: ${totalSuccess} successful, ${totalFailed} failed`;
                processingStatus.className = totalFailed === 0 ? 'text-green-600 font-medium' : 'text-yellow-600 font-medium';
            }

            // Show completion message
            showToast(`Processing complete: ${totalSuccess} successful, ${totalFailed} failed`, 
                     totalFailed === 0 ? 'success' : 'warning');
            
            if (totalSuccess > 0) {
                scanCompleteMessage.classList.remove('hidden');
                scanCompleteMessage.classList.add('success-banner');
                celebrateScanSuccess();
                
                // Reload contacts and refresh visualizations after successful upload
                await loadContacts();
                refreshAllVisualizations();
            }

        } catch (error) {
            console.error('Error processing files:', error);
            showToast('Failed to process files. Please try again.', 'error');
            // Reset UI state
            resetBtn.classList.add('hidden');
            if (processingStatus) processingStatus.textContent = '';
            uploadProgress.textContent = '';
        } finally {
            setScanProcessing(false);
            setUploadShimmer(false);
            // Reset the file input to allow selecting the same files again if needed
            fileUpload.value = '';
        }
    }

    fileUpload.addEventListener('change', async (event) => {
        await ingestImageFiles(event.target.files);
    });
    document.getElementById('fileUploadBack')?.addEventListener('change', async (event) => {
        const backFile = event.target.files?.[0];
        if (!backFile) return;
        if (pendingFrontUpload) {
            const front = pendingFrontUpload;
            pendingFrontUpload = null;
            await ingestPairedSides(front, backFile);
            return;
        }
        await ingestImageFiles([backFile]);
    });

    // Helper function to create thumbnail elements
    function createThumbnailElement(file, index, status, label = '') {
        const thumbnailContainer = document.createElement('div');
        thumbnailContainer.className = 'relative inline-block m-2';
        thumbnailContainer.id = `thumbnail-container-${index}`;
        
        const thumbnail = document.createElement('img');
        thumbnail.src = URL.createObjectURL(file);
        thumbnail.className = 'thumbnail w-32 h-32 object-cover rounded';
        thumbnail.id = `thumbnail-${index}`;
        
        const statusOverlay = document.createElement('div');
        let statusClass, statusText;
        
        if (status === true) {
            statusClass = 'bg-green-500';
            statusText = 'Processed';
        } else if (status === false) {
            statusClass = 'bg-red-500';
            statusText = 'Failed';
        } else {
            statusClass = 'bg-black bg-opacity-50';
            statusText = 'Pending...';
        }
        
        statusOverlay.className = `absolute bottom-0 left-0 right-0 ${statusClass} text-white text-xs p-1 text-center`;
        statusOverlay.textContent = statusText;
        statusOverlay.id = `status-${index}`;
        
        // Only add checkmark if status is known
        if (status !== null) {
            const checkmark = document.createElement('div');
            checkmark.className = `absolute top-2 right-2 ${
                status ? 'bg-green-500' : 'bg-red-500'
            } text-white rounded-full w-6 h-6 flex items-center justify-center shadow-md`;
            checkmark.innerHTML = status ? '✓' : '✕';
            checkmark.id = `checkmark-${index}`;
            thumbnailContainer.appendChild(checkmark);
        }
        
        thumbnailContainer.appendChild(thumbnail);
        if (label) {
            const sideLabel = document.createElement('span');
            sideLabel.className = 'thumbnail-side-label';
            sideLabel.textContent = label;
            thumbnailContainer.appendChild(sideLabel);
        }
        thumbnailContainer.appendChild(statusOverlay);
        thumbnailGallery.appendChild(thumbnailContainer);

        // Clean up object URL when thumbnail is loaded
        thumbnail.onload = () => URL.revokeObjectURL(thumbnail.src);
    }

    // Helper function to update thumbnail status
    function updateThumbnailStatus(index, success, customStatus = null) {
        console.log(`updateThumbnailStatus called for index ${index}, success: ${success}, message: ${customStatus || (success ? 'Processed' : 'Failed')}`);
        
        // Get DOM elements
        const statusElement = document.getElementById(`status-${index}`);
        const container = document.getElementById(`thumbnail-container-${index}`);
        
        if (!statusElement) {
            console.error(`Status element not found for index ${index}`);
            return;
        }
        
        // Determine the status text and class
        let statusText, statusClass;
        
        if (customStatus !== null) {
            // Use custom status message (for "Processing..." etc.)
            statusText = customStatus;
            statusClass = 'bg-black bg-opacity-50';
        } else if (success === true) {
            // Success state
            statusText = 'Processed';
            statusClass = 'bg-green-500';
        } else if (success === false) {
            // Error state
            statusText = 'Failed';
            statusClass = 'bg-red-500';
        } else {
            // Pending state (success is null)
            statusText = 'Pending...';
            statusClass = 'bg-black bg-opacity-50';
        }
        
        // Update status text and class
        statusElement.textContent = statusText;
        statusElement.className = `absolute bottom-0 left-0 right-0 ${statusClass} text-white text-xs p-1 text-center`;
        
        // Only add/update checkmark for success or failure (not for pending/processing)
        if (success === true || success === false) {
            // Add or update checkmark
            let checkmark = document.getElementById(`checkmark-${index}`);
            
            if (!checkmark && container) {
                checkmark = document.createElement('div');
                checkmark.className = `absolute top-2 right-2 ${
                    success ? 'bg-green-500' : 'bg-red-500'
                } text-white rounded-full w-6 h-6 flex items-center justify-center shadow-md`;
                checkmark.innerHTML = success ? '✓' : '✕';
                checkmark.id = `checkmark-${index}`;
                container.appendChild(checkmark);
            } else if (checkmark) {
                checkmark.className = `absolute top-2 right-2 ${
                    success ? 'bg-green-500' : 'bg-red-500'
                } text-white rounded-full w-6 h-6 flex items-center justify-center shadow-md`;
                checkmark.innerHTML = success ? '✓' : '✕';
            }
            
            // Add a brief animation for completed items
            if (checkmark) {
                checkmark.classList.add('animate-bounce');
                setTimeout(() => {
                    if (checkmark && checkmark.classList.contains('animate-bounce')) {
                        checkmark.classList.remove('animate-bounce');
                    }
                }, 1000);
            }
        }
    }

    // Folio full in-panel camera
    const dropZone = document.getElementById('dropZone');
    const cameraFlash = document.getElementById('cameraFlash');
    const cameraPanel = document.getElementById('cameraPanel');
    const cameraVideo = document.getElementById('cameraVideo');
    const cameraCanvas = document.getElementById('cameraCanvas');
    const cameraIdle = document.getElementById('cameraIdle');
    const cameraLiveUi = document.getElementById('cameraLiveUi');
    const cameraShutterBtn = document.getElementById('cameraShutterBtn');
    const cameraCloseBtn = document.getElementById('cameraCloseBtn');
    const cameraLibraryBtn = document.getElementById('cameraLibraryBtn');
    const scanMascotLive = document.getElementById('scanMascotLive');
    const cameraFlipBar = document.getElementById('cameraFlipBar');
    const cameraSkipBackBtn = document.getElementById('cameraSkipBackBtn');
    const cameraCardGuide = document.getElementById('cameraCardGuide');
    const cameraAlignHint = document.getElementById('cameraAlignHint');
    let cameraOpenBusy = false;
    let cameraStream = null;
    let cameraCapturing = false;
    let pendingFrontFile = null;
    let awaitingBackSide = false;
    let alignTimer = null;
    let alignHits = 0;
    const alignProbe = document.createElement('canvas');

    function setCameraSideChip(label) {
        const chip = document.getElementById('cameraSideChip');
        if (chip) chip.textContent = label;
        cameraShutterBtn?.setAttribute('aria-label', `Capture ${String(label || 'card').toLowerCase()} of card`);
    }

    function hideFlipBar() {
        cameraFlipBar?.classList.add('hidden');
        cameraPanel?.classList.remove('is-awaiting-back');
        const thumb = document.getElementById('cameraFlipThumb');
        if (thumb?.src?.startsWith('blob:')) {
            URL.revokeObjectURL(thumb.src);
            thumb.removeAttribute('src');
        }
        setCameraSideChip('Front');
    }

    function showFlipBar(file) {
        const thumb = document.getElementById('cameraFlipThumb');
        if (thumb) thumb.src = URL.createObjectURL(file);
        cameraFlipBar?.classList.remove('hidden');
        cameraPanel?.classList.add('is-awaiting-back');
        setCameraSideChip('Back');
    }

    function getCameraSourceEl(preferred) {
        if (preferred?.classList?.contains('camera-panel__shutter')) {
            return preferred;
        }
        return preferred || cameraShutterBtn || cameraPanel;
    }

    function playCameraFlash(sourceEl) {
        if (!cameraFlash || !sourceEl) return () => {};

        const rect = sourceEl.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        cameraFlash.style.setProperty('--flash-x', `${x}px`);
        cameraFlash.style.setProperty('--flash-y', `${y}px`);

        cameraFlash.classList.remove('is-on');
        void cameraFlash.offsetWidth;
        cameraFlash.classList.add('is-on');

        const pressTarget = sourceEl.closest('.camera-panel__shutter') || sourceEl;
        pressTarget.classList.add('is-pressing');
        document.body.classList.add('camera-flashing');

        return () => {
            cameraFlash.classList.remove('is-on');
            pressTarget.classList.remove('is-pressing');
            document.body.classList.remove('camera-flashing');
            cameraShutterBtn?.classList.remove('is-pressing');
        };
    }

    function setMascotSrc(src) {
        const mascot = document.getElementById('scanMascot');
        if (mascot) mascot.src = src;
        if (scanMascotLive) scanMascotLive.src = src;
    }

    function setGuideAligned(aligned) {
        cameraCardGuide?.classList.toggle('is-aligned', aligned);
        cameraPanel?.classList.toggle('is-aligned', aligned);
        if (cameraAlignHint) {
            cameraAlignHint.textContent = aligned
                ? 'Perfect — tap capture'
                : 'Fit the card inside the rectangle';
        }
    }

    function stopGuideAlignLoop() {
        if (alignTimer) {
            window.clearTimeout(alignTimer);
            alignTimer = null;
        }
        alignHits = 0;
        setGuideAligned(false);
    }

    function scoreCardInGuide(videoEl, guideEl) {
        if (!videoEl?.videoWidth || !guideEl) return 0;
        const box = mapOverlayToSourceBox(videoEl, guideEl, videoEl.videoWidth, videoEl.videoHeight);
        if (!box || box.width < 24 || box.height < 16) return 0;
        const pad = Math.min(box.width, box.height) * 0.16;
        const region = {
            x: Math.max(0, box.x - pad),
            y: Math.max(0, box.y - pad),
            width: box.width + pad * 2,
            height: box.height + pad * 2,
        };
        region.width = Math.min(videoEl.videoWidth - region.x, region.width);
        region.height = Math.min(videoEl.videoHeight - region.y, region.height);
        const pw = 220;
        const ph = Math.max(24, Math.round(pw * (region.height / Math.max(1, region.width))));
        alignProbe.width = pw;
        alignProbe.height = ph;
        const ctx = alignProbe.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(videoEl, region.x, region.y, region.width, region.height, 0, 0, pw, ph);

        if (window.FolioCrop?.detectQuad) {
            const found = FolioCrop.detectQuad(alignProbe);
            if (!found || found.method === 'fallback' || found.score < 0.3) return 0;
            const xs = found.quad.map((p) => p[0]);
            const ys = found.quad.map((p) => p[1]);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const bw = Math.max(1, maxX - minX);
            const bh = Math.max(1, maxY - minY);
            const gx = ((box.x - region.x) / region.width) * pw;
            const gy = ((box.y - region.y) / region.height) * ph;
            const gw = (box.width / region.width) * pw;
            const gh = (box.height / region.height) * ph;
            const overlapW = Math.max(0, Math.min(maxX, gx + gw) - Math.max(minX, gx));
            const overlapH = Math.max(0, Math.min(maxY, gy + gh) - Math.max(minY, gy));
            const overlap = overlapW * overlapH;
            const guideCover = overlap / Math.max(1, gw * gh);
            const cardInside = overlap / (bw * bh);
            const aspect = bw / bh;
            if (guideCover < 0.72 || cardInside < 0.78) return 0;
            if (aspect < 1.28 || aspect > 2.15) return 0;
            const ordered = FolioCrop.orderCorners(found.quad);
            const skewY = Math.abs(ordered[0][1] - ordered[1][1]) / ph;
            const skewX = Math.abs(ordered[0][0] - ordered[3][0]) / pw;
            if (skewY > 0.1 || skewX > 0.1) return 0;
            return found.score;
        }

        let data;
        try {
            data = ctx.getImageData(0, 0, pw, ph).data;
        } catch (err) {
            return 0;
        }
        const luma = new Uint8Array(pw * ph);
        let sum = 0;
        for (let i = 0; i < luma.length; i += 1) {
            const j = i * 4;
            const v = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
            luma[i] = v;
            sum += v;
        }
        const mean = sum / luma.length;
        let varSum = 0;
        for (let i = 0; i < luma.length; i += 1) {
            const d = luma[i] - mean;
            varSum += d * d;
        }
        const std = Math.sqrt(varSum / luma.length);
        if (mean < 88 || mean > 236 || std < 14 || std > 58) return 0;
        return Math.min(1, std / 32);
    }

    function tickGuideAlign() {
        if (!cameraStream || cameraCapturing) {
            alignTimer = window.setTimeout(tickGuideAlign, 180);
            return;
        }
        const score = scoreCardInGuide(cameraVideo, cameraCardGuide);
        if (score >= 0.42) alignHits += 1;
        else alignHits = Math.max(0, alignHits - 1);
        setGuideAligned(alignHits >= 3);
        alignTimer = window.setTimeout(tickGuideAlign, 160);
    }

    function startGuideAlignLoop() {
        stopGuideAlignLoop();
        alignTimer = window.setTimeout(tickGuideAlign, 220);
    }

    function setCameraLiveUi(isLive) {
        cameraPanel?.classList.toggle('is-live', isLive);
        document.body.classList.toggle('camera-live', isLive);
        cameraIdle?.classList.toggle('hidden', isLive);
        cameraLiveUi?.classList.toggle('hidden', !isLive);
        setMascotSrc(isLive ? 'assets/mascot-scanning.svg' : 'assets/mascot-idle.svg');
        if (isLive) startGuideAlignLoop();
        else stopGuideAlignLoop();
    }

    function stopLiveCamera() {
        stopGuideAlignLoop();
        if (cameraStream) {
            cameraStream.getTracks().forEach((track) => track.stop());
            cameraStream = null;
        }
        if (cameraVideo) {
            cameraVideo.srcObject = null;
        }
        hideFlipBar();
        awaitingBackSide = false;
        setCameraLiveUi(false);
    }

    async function closeCameraAndMaybeSave() {
        const pending = pendingFrontFile;
        pendingFrontFile = null;
        awaitingBackSide = false;
        stopLiveCamera();
        if (pending) {
            await ingestImageFiles([pending], { skipPairPrompt: true, alreadyCropped: true });
        }
    }

    async function requestCameraStream() {
        const wide = isWideAppLayout();
        if (!wide) {
            try {
                return await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { exact: 'environment' },
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                });
            } catch (err) {
                console.warn('Rear camera unavailable, trying any back-facing device', err);
            }
            try {
                return await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { facingMode: { ideal: 'environment' } },
                });
            } catch (err) {
                console.warn('Ideal rear camera failed, trying any camera', err);
            }
        }
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            });
        } catch (err) {
            console.warn('Preferred camera failed, trying any video device', err);
            return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        }
    }

    function applyNaturalCameraPreview(video) {
        if (!video) return;
        video.style.setProperty('transform', 'none', 'important');
        video.style.setProperty('-webkit-transform', 'none', 'important');
    }

    async function waitForCameraFrame(video, timeoutMs = 4000) {
        if (!video) return false;
        if (video.readyState >= 2 && video.videoWidth > 0) return true;
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                video.removeEventListener('loadeddata', onReady);
                video.removeEventListener('loadedmetadata', onReady);
                clearTimeout(timer);
                resolve(video.videoWidth > 0);
            };
            const onReady = () => {
                if (video.videoWidth > 0 || video.readyState >= 2) finish();
            };
            video.addEventListener('loadeddata', onReady);
            video.addEventListener('loadedmetadata', onReady);
            const timer = setTimeout(finish, timeoutMs);
        });
    }

    async function startLiveCamera(fromEl, options = {}) {
        const fallbackToLibrary = options.fallbackToLibrary !== false;
        if (cameraOpenBusy) return;
        if (!userId) {
            showToast('Please sign in to upload files', 'error');
            showSignInModal();
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            if (fallbackToLibrary) openPhotoLibrary(fromEl);
            else showToast('Camera is not supported in this browser', 'error');
            return;
        }

        if (cameraStream) {
            cameraPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return;
        }

        cameraOpenBusy = true;
        try {
            const wide = isWideAppLayout();
            cameraStream = await requestCameraStream();
            const facing = cameraStream.getVideoTracks()[0]?.getSettings?.()?.facingMode || '';
            cameraPanel?.classList.toggle('is-selfie', facing === 'user' || (wide && facing !== 'environment'));
            if (cameraVideo) {
                cameraVideo.setAttribute('playsinline', 'true');
                cameraVideo.setAttribute('webkit-playsinline', 'true');
                cameraVideo.muted = true;
                applyNaturalCameraPreview(cameraVideo);
                cameraVideo.srcObject = cameraStream;
                await waitForCameraFrame(cameraVideo);
                await cameraVideo.play().catch((err) => {
                    console.warn('video.play failed', err);
                });
            }
            setCameraLiveUi(true);
            setCameraSideChip('Front');
            cameraPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            console.warn('Live camera unavailable', err);
            if (fallbackToLibrary) {
                showToast('Camera unavailable — opening photo library', 'error');
                openPhotoLibrary(fromEl);
            } else {
                showToast('Could not open the camera. Tap the panel to try again.', 'error');
            }
        } finally {
            cameraOpenBusy = false;
        }
    }

    function openPhotoLibrary(fromEl) {
        if (!fileUpload) return;
        if (!userId) {
            showToast('Please sign in to upload files', 'error');
            showSignInModal();
            return;
        }
        fileUpload.click();
    }

    async function captureFromLiveCamera() {
        if (!cameraStream || !cameraVideo || !cameraCanvas || cameraCapturing) return;
        if (cameraVideo.readyState < 2 || !cameraVideo.videoWidth) {
            showToast('Camera is still starting…');
            return;
        }

        cameraCapturing = true;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        let cleanup = () => {};
        if (!reduceMotion) {
            cleanup = playCameraFlash(cameraShutterBtn || cameraPanel);
        }

        try {
            const width = cameraVideo.videoWidth || 1280;
            const height = cameraVideo.videoHeight || 720;
            cameraCanvas.width = width;
            cameraCanvas.height = height;
            const ctx = cameraCanvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(cameraVideo, 0, 0, width, height);

            const guide = document.getElementById('cameraCardGuide');
            const framed = cropCanvasToGuide(cameraCanvas, cameraVideo, guide);
            const file = await new Promise((resolve, reject) => {
                framed.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('Capture failed'));
                        return;
                    }
                    const side = awaitingBackSide ? 'back' : 'front';
                    resolve(new File([blob], `folio-frame-${side}-${Date.now()}.jpg`, { type: 'image/jpeg' }));
                }, 'image/jpeg', 0.92);
            });

            if (awaitingBackSide && pendingFrontFile) {
                const front = pendingFrontFile;
                pendingFrontFile = null;
                awaitingBackSide = false;
                hideFlipBar();
                stopLiveCamera();
                setMascotSrc('assets/mascot-scanning.svg');
                await ingestImageFiles([front, file], { pairSides: true, alreadyCropped: true });
                return;
            }

            pendingFrontFile = file;
            awaitingBackSide = true;
            showFlipBar(file);
            showToast('Now scan the back side, or skip if there is no back');
        } catch (err) {
            console.error(err);
            showToast('Could not capture photo', 'error');
        } finally {
            window.setTimeout(() => {
                cleanup();
            }, reduceMotion ? 0 : 420);
            cameraCapturing = false;
        }
    }

    cameraShutterBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        captureFromLiveCamera();
    });
    cameraCloseBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeCameraAndMaybeSave();
    });
    cameraSkipBackBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeCameraAndMaybeSave();
    });
    cameraFlipBar?.addEventListener('click', (e) => {
        if (!e.target.closest('#cameraSkipBackBtn, .camera-panel__flip-skip')) return;
        e.preventDefault();
        e.stopPropagation();
        closeCameraAndMaybeSave();
    }, true);
    cameraLibraryBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPhotoLibrary(cameraLibraryBtn);
    });
    cameraPanel?.addEventListener('click', (e) => {
        if (cameraStream) return;
        if (e.target.closest('button')) return;
        startLiveCamera(cameraPanel);
    });

    function isWideAppLayout() {
        return window.matchMedia('(min-width: 1024px)').matches;
    }

    function updateScanIdleCopy() {
        const sub = document.getElementById('cameraIdleSub');
        if (!sub) return;
        sub.textContent = isWideAppLayout()
            ? 'Drop a card photo, or open the webcam rectangle'
            : 'Fit the visiting card inside the rectangle';
    }

    updateScanIdleCopy();
    window.matchMedia('(min-width: 1024px)').addEventListener('change', updateScanIdleCopy);

    document.getElementById('desktopWebcamBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        startLiveCamera(e.currentTarget);
    });
    document.getElementById('desktopUploadBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPhotoLibrary(e.currentTarget);
    });

    // Auto-open camera on phones/tablets only — laptops start from drop/upload
    if (!isWideAppLayout() && !scanContent?.classList.contains('hidden')) {
        window.setTimeout(() => startLiveCamera(cameraPanel, { fallbackToLibrary: false }), 350);
    }
    scanTab?.addEventListener('click', () => {
        if (isWideAppLayout()) return;
        window.setTimeout(() => startLiveCamera(cameraPanel, { fallbackToLibrary: false }), 200);
    });

    let networkResizeTimer = null;
    window.addEventListener('resize', () => {
        if (networkContent?.classList.contains('hidden')) return;
        window.clearTimeout(networkResizeTimer);
        networkResizeTimer = window.setTimeout(() => {
            if (typeof updateNetworkVisualization === 'function' && contactsData.length > 1) {
                updateNetworkVisualization();
            }
        }, 250);
    });

    const stopCameraOnTabLeave = () => closeCameraAndMaybeSave();
    contactsTab?.addEventListener('click', stopCameraOnTabLeave);
    networkTab?.addEventListener('click', stopCameraOnTabLeave);
    document.getElementById('chatButton')?.addEventListener('click', stopCameraOnTabLeave);
    window.addEventListener('pagehide', () => {
        closeCameraAndMaybeSave();
    });

    if (cameraPanel && fileUpload) {
        ['dragenter', 'dragover'].forEach(evt => {
            cameraPanel.addEventListener(evt, (e) => {
                e.preventDefault();
                cameraPanel.classList.add('is-dragover');
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            cameraPanel.addEventListener(evt, (e) => {
                e.preventDefault();
                cameraPanel.classList.remove('is-dragover');
            });
        });
        cameraPanel.addEventListener('drop', (e) => {
            const files = e.dataTransfer?.files;
            if (!files?.length) return;
            const dt = new DataTransfer();
            Array.from(files).forEach(f => {
                if (f.type.startsWith('image/')) dt.items.add(f);
            });
            if (dt.files.length) {
                fileUpload.files = dt.files;
                fileUpload.dispatchEvent(new Event('change'));
            }
        });
    }

    if (dropZone && fileUpload) {
        ['dragenter', 'dragover'].forEach(evt => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.add('is-dragover');
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.remove('is-dragover');
            });
        });
        dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer?.files;
            if (!files?.length) return;
            const dt = new DataTransfer();
            Array.from(files).forEach(f => {
                if (f.type.startsWith('image/')) dt.items.add(f);
            });
            if (dt.files.length) {
                fileUpload.files = dt.files;
                fileUpload.dispatchEvent(new Event('change'));
            }
        });
    }

    // ——— My Card studio ———
    const MY_CARD_FIELD_IDS = [
        'myCardName', 'myCardTitle', 'myCardCompany', 'myCardBio', 'myCardEmail',
        'myCardPhone', 'myCardWebsite', 'myCardLinkedin', 'myCardTwitter',
        'myCardInstagram', 'myCardGithub', 'myCardAddress', 'myCardSlug'
    ];
    const LOCK_THEMES = {
        navy: { top: '#121a2e', bottom: '#1b2a4a', ink: '#faf7f1', accent: '#c4a574', qrDark: '#1b2a4a', qrLight: '#ffffff' },
        cream: { top: '#f7f3eb', bottom: '#e8e1d4', ink: '#1b2a4a', accent: '#b08d55', qrDark: '#1b2a4a', qrLight: '#ffffff' },
        midnight: { top: '#070b12', bottom: '#141c2c', ink: '#f4f0e8', accent: '#c4a574', qrDark: '#0e1420', qrLight: '#faf7f1' },
        copper: { top: '#8a6a3a', bottom: '#c4a574', ink: '#1b2a4a', accent: '#faf7f1', qrDark: '#1b2a4a', qrLight: '#faf7f1' },
    };
    let lockTemplate = 'navy';
    let publicCardData = null;
    let myCardSyncTimer = null;

    function slugifyCard(value) {
        return (value || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    }

    function cardInitials(name) {
        const parts = (name || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return 'F';
        return ((parts[0][0] || '') + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }

    function myCardPublicUrl(card) {
        const slug = slugifyCard(card?.slug || card?.name || userId || TEMP_USER_ID) || (userId || TEMP_USER_ID);
        return `${window.location.origin}/?card=${encodeURIComponent(slug)}`;
    }

    function qrPayloadForCard(card) {
        const mode = document.querySelector('input[name="myCardQrMode"]:checked')?.value || card.qrMode || 'url';
        if (mode === 'vcard') return buildVCard({ ...card, profileUrl: myCardPublicUrl(card) });
        return myCardPublicUrl(card);
    }

    function socialLink(label, href) {
        const url = normalizeHref(href);
        if (!url) return '';
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    }

    function fillDigitalCard(el, card) {
        if (!el) return;
        const theme = card.theme || 'navy';
        const layout = card.layout || 'classic';
        el.dataset.theme = theme;
        el.dataset.layout = layout;
        el.style.setProperty('--dc-accent', card.accent || '#c4a574');
        const avatarSrc = (card.avatar || '').startsWith('data:image/') || /^(https?:)/i.test(card.avatar || '')
            ? card.avatar
            : '';
        const avatar = avatarSrc
            ? `<img class="dc-card__avatar" src="${avatarSrc}" alt="">`
            : `<div class="dc-card__avatar dc-card__avatar--fallback">${escapeHtml(cardInitials(card.name))}</div>`;
        const roleLine = [card.title, card.company].filter(Boolean).join(' · ');
        const contactBits = [
            card.email ? `<a href="mailto:${escapeHtml(card.email)}">${escapeHtml(card.email)}</a>` : '',
            card.phone ? `<a href="tel:${escapeHtml(card.phone)}">${escapeHtml(card.phone)}</a>` : '',
            card.website ? `<a href="${escapeHtml(normalizeHref(card.website))}" target="_blank" rel="noopener">${escapeHtml(card.website)}</a>` : '',
        ].filter(Boolean).join('');
        el.innerHTML = `
            <div class="dc-card__top">
                ${avatar}
                <div>
                    <h3 class="dc-card__name">${escapeHtml(card.name || 'Your name')}</h3>
                    <p class="dc-card__meta">${escapeHtml(roleLine || 'Title · Company')}</p>
                </div>
            </div>
            ${card.bio ? `<p class="dc-card__bio">${escapeHtml(card.bio)}</p>` : ''}
            <div class="dc-card__contacts">${contactBits}</div>
            <div class="dc-card__socials">
                ${socialLink('LinkedIn', card.linkedin)}
                ${socialLink('X', card.twitter)}
                ${socialLink('Instagram', card.instagram)}
                ${socialLink('GitHub', card.github)}
            </div>
        `;
    }

    function readMyCardForm() {
        const stored = loadMyCard();
        return {
            name: document.getElementById('myCardName')?.value?.trim() || '',
            title: document.getElementById('myCardTitle')?.value?.trim() || '',
            company: document.getElementById('myCardCompany')?.value?.trim() || '',
            bio: document.getElementById('myCardBio')?.value?.trim() || '',
            email: document.getElementById('myCardEmail')?.value?.trim() || '',
            phone: document.getElementById('myCardPhone')?.value?.trim() || '',
            website: document.getElementById('myCardWebsite')?.value?.trim() || '',
            linkedin: document.getElementById('myCardLinkedin')?.value?.trim() || '',
            twitter: document.getElementById('myCardTwitter')?.value?.trim() || '',
            instagram: document.getElementById('myCardInstagram')?.value?.trim() || '',
            github: document.getElementById('myCardGithub')?.value?.trim() || '',
            address: document.getElementById('myCardAddress')?.value?.trim() || '',
            slug: slugifyCard(document.getElementById('myCardSlug')?.value) || '',
            avatar: stored.avatar || '',
            theme: stored.theme || 'navy',
            layout: stored.layout || 'classic',
            accent: document.getElementById('myCardAccent')?.value || stored.accent || '#c4a574',
            qrMode: document.querySelector('input[name="myCardQrMode"]:checked')?.value || stored.qrMode || 'url',
        };
    }

    function fillMyCardForm(card) {
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
        };
        setVal('myCardName', card.name);
        setVal('myCardTitle', card.title);
        setVal('myCardCompany', card.company);
        setVal('myCardBio', card.bio);
        setVal('myCardEmail', card.email);
        setVal('myCardPhone', card.phone);
        setVal('myCardWebsite', card.website);
        setVal('myCardLinkedin', card.linkedin);
        setVal('myCardTwitter', card.twitter);
        setVal('myCardInstagram', card.instagram);
        setVal('myCardGithub', card.github);
        setVal('myCardAddress', card.address);
        setVal('myCardSlug', card.slug);
        const accent = document.getElementById('myCardAccent');
        if (accent) accent.value = card.accent || '#c4a574';
        const avatarImg = document.getElementById('myCardAvatarImg');
        const avatarFallback = document.getElementById('myCardAvatarFallback');
        if (avatarImg && avatarFallback) {
            if (card.avatar) {
                avatarImg.src = card.avatar;
                avatarImg.classList.remove('hidden');
                avatarFallback.classList.add('hidden');
            } else {
                avatarImg.removeAttribute('src');
                avatarImg.classList.add('hidden');
                avatarFallback.classList.remove('hidden');
            }
        }
        document.querySelectorAll('#myCardThemeRow [data-theme]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.theme === (card.theme || 'navy'));
        });
        document.querySelectorAll('#myCardLayoutRow [data-layout]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.layout === (card.layout || 'classic'));
        });
        const qrMode = card.qrMode === 'vcard' ? 'vcard' : 'url';
        document.querySelectorAll('input[name="myCardQrMode"]').forEach((input) => {
            input.checked = input.value === qrMode;
        });
        lockTemplate = card.lockTemplate || card.theme || 'navy';
        document.querySelectorAll('#lockTemplateRow [data-lock-template]').forEach((btn) => {
            btn.classList.toggle('is-active', btn.dataset.lockTemplate === lockTemplate);
        });
    }

    function renderMyCardQr(card, canvasEl) {
        const canvas = canvasEl || document.getElementById('myCardQrCanvas');
        if (!canvas || typeof QRCode === 'undefined') return;
        const payload = qrPayloadForCard(card);
        if (!card.name && !card.email && !card.phone) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#5c6578';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Add your details', canvas.width / 2, canvas.height / 2);
            return;
        }
        QRCode.toCanvas(canvas, payload, {
            width: canvas.width || 220,
            margin: 1,
            color: { dark: '#1b2a4a', light: '#ffffff' },
            errorCorrectionLevel: 'M',
        }, (err) => {
            if (err) console.warn('QR render failed', err);
        });
    }

    function refreshMyCardPreview() {
        const card = readMyCardForm();
        fillDigitalCard(document.getElementById('digitalCardPreview'), card);
        renderMyCardQr(card);
        const hint = document.getElementById('myCardSlugHint');
        const urlLabel = document.getElementById('myCardPublicUrl');
        const url = myCardPublicUrl(card);
        if (hint) hint.textContent = `Public link: ${url}`;
        if (urlLabel) urlLabel.textContent = url;
        renderLockPreview();
    }

    function hydrateMyCardStudio() {
        fillMyCardForm(loadMyCard());
        refreshMyCardPreview();
        syncMyCardFromApi();
    }

    async function syncMyCardFromApi() {
        if (!userId || !navigator.onLine) return;
        try {
            const res = await fetch(`${API_URL}/profile?userId=${encodeURIComponent(userId)}`, {
                headers: authHeaders(),
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data?.profile?.name) {
                const local = loadMyCard();
                const merged = { ...local, ...data.profile };
                if (local.avatar && !data.profile.avatar) merged.avatar = local.avatar;
                saveMyCard(merged);
                fillMyCardForm(merged);
                refreshMyCardPreview();
            }
        } catch (err) {
            /* local card is enough until API is deployed */
        }
    }

    async function persistMyCard(card, { toast = true } = {}) {
        if (!card.name) {
            showToast('Add your name before saving', 'warning');
            return false;
        }
        if (!card.slug) card.slug = slugifyCard(card.name) || slugifyCard(userId);
        card.lockTemplate = lockTemplate;
        saveMyCard(card);
        refreshMyCardPreview();
        if (navigator.onLine && userId) {
            try {
                const res = await fetch(`${API_URL}/profile`, {
                    method: 'PUT',
                    headers: authHeaders(),
                    body: JSON.stringify({ ...card, userId }),
                });
                if (res.status === 409) {
                    showToast('That public link is already taken', 'warning');
                    return false;
                }
            } catch (err) {
                /* stay on localStorage */
            }
        }
        if (toast) showToast('My Card saved', 'success');
        return true;
    }

    async function downloadProfileVcf(card, slug) {
        const filename = `${(card.name || 'contact').replace(/[^\w.-]+/g, '_')}.vcf`;
        if (navigator.onLine) {
            try {
                if (slug) {
                    const res = await fetch(`${API_URL}/vcard/profile/${encodeURIComponent(slug)}`);
                    if (res.ok) {
                        downloadBlob(new Blob([await res.text()], { type: 'text/vcard' }), filename);
                        return;
                    }
                }
                const posted = await fetch(`${API_URL}/vcard`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...card, profileUrl: myCardPublicUrl(card), version: '3.0' }),
                });
                if (posted.ok) {
                    downloadBlob(new Blob([await posted.text()], { type: 'text/vcard' }), filename);
                    return;
                }
            } catch (err) {
                /* fall through to local generator */
            }
        }
        downloadBlob(new Blob([buildVCard({ ...card, profileUrl: myCardPublicUrl(card) })], { type: 'text/vcard' }), filename);
    }

    function compressAvatarFile(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                const size = 512;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                const scale = Math.max(size / img.width, size / img.height);
                const w = img.width * scale;
                const h = img.height * scale;
                ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/jpeg', 0.82));
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Could not read photo'));
            };
            img.src = url;
        });
    }

    function loadImage(src) {
        return new Promise((resolve) => {
            if (!src) {
                resolve(null);
                return;
            }
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function qrToCanvas(payload, size, colors) {
        return new Promise((resolve, reject) => {
            if (typeof QRCode === 'undefined') {
                reject(new Error('QR library missing'));
                return;
            }
            const canvas = document.createElement('canvas');
            QRCode.toCanvas(canvas, payload, {
                width: size,
                margin: 1,
                color: { dark: colors.qrDark, light: colors.qrLight },
                errorCorrectionLevel: 'M',
            }, (err) => {
                if (err) reject(err);
                else resolve(canvas);
            });
        });
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        const radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
    }

    async function drawLockWallpaper(canvas, card, templateKey) {
        const theme = LOCK_THEMES[templateKey] || LOCK_THEMES.navy;
        const w = canvas.width;
        const h = canvas.height;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, theme.top);
        grad.addColorStop(1, theme.bottom);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(w * 0.82, h * 0.18, w * 0.38, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        const avatarSize = Math.round(w * 0.28);
        const avatarY = Math.round(h * 0.18);
        const avatarX = Math.round((w - avatarSize) / 2);
        const avatarImg = await loadImage(card.avatar);
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        if (avatarImg) {
            ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
        } else {
            ctx.fillStyle = theme.accent;
            ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
            ctx.fillStyle = theme.ink;
            ctx.font = `700 ${Math.round(avatarSize * 0.32)}px Georgia, serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cardInitials(card.name), avatarX + avatarSize / 2, avatarY + avatarSize / 2 + 4);
        }
        ctx.restore();
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = Math.max(4, w * 0.008);
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + ctx.lineWidth, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = theme.ink;
        ctx.textAlign = 'center';
        ctx.font = `700 ${Math.round(w * 0.072)}px Georgia, serif`;
        ctx.fillText(card.name || 'Your name', w / 2, avatarY + avatarSize + Math.round(h * 0.055));
        ctx.font = `500 ${Math.round(w * 0.032)}px "DM Sans", sans-serif`;
        ctx.globalAlpha = 0.78;
        const role = [card.title, card.company].filter(Boolean).join('  ·  ') || 'Add your title';
        ctx.fillText(role, w / 2, avatarY + avatarSize + Math.round(h * 0.09));
        ctx.globalAlpha = 1;

        const qrSize = Math.round(w * 0.42);
        const qrY = Math.round(h * 0.58);
        const qrX = Math.round((w - qrSize) / 2);
        try {
            const qrCanvas = await qrToCanvas(myCardPublicUrl(card), qrSize, theme);
            const pad = Math.round(qrSize * 0.08);
            ctx.fillStyle = theme.qrLight;
            roundRectPath(ctx, qrX - pad / 2, qrY - pad / 2, qrSize + pad, qrSize + pad, 28);
            ctx.fill();
            ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);
        } catch (err) {
            console.warn('Lock screen QR failed', err);
        }

        ctx.fillStyle = theme.ink;
        ctx.globalAlpha = 0.8;
        ctx.font = `600 ${Math.round(w * 0.028)}px "DM Sans", sans-serif`;
        ctx.fillText('Scan to save contact', w / 2, qrY + qrSize + Math.round(h * 0.045));
        ctx.globalAlpha = 0.45;
        ctx.font = `600 ${Math.round(w * 0.022)}px Georgia, serif`;
        ctx.fillText('Folio', w / 2, h - Math.round(h * 0.045));
        ctx.globalAlpha = 1;
    }

    async function renderLockPreview() {
        const preview = document.getElementById('lockPreviewCanvas');
        if (!preview) return;
        const card = readMyCardForm();
        const size = (document.getElementById('lockSizeSelect')?.value || '1080x1920').split('x');
        const ratio = Number(size[1]) / Number(size[0]);
        preview.width = 270;
        preview.height = Math.round(270 * ratio);
        await drawLockWallpaper(preview, card, lockTemplate);
    }

    async function downloadLockWallpaper() {
        const card = readMyCardForm();
        if (!card.name) {
            showToast('Add your name before generating a wallpaper', 'warning');
            return;
        }
        const [width, height] = (document.getElementById('lockSizeSelect')?.value || '1080x1920').split('x').map(Number);
        const full = document.getElementById('lockFullCanvas') || document.createElement('canvas');
        full.width = width;
        full.height = height;
        await drawLockWallpaper(full, card, lockTemplate);
        const link = document.createElement('a');
        link.download = `folio-lock-screen-${width}x${height}.png`;
        link.href = full.toDataURL('image/png');
        link.click();
        showToast('Wallpaper saved', 'success');
    }

    function switchDcTab(tab) {
        document.querySelectorAll('.dc-tab').forEach((btn) => {
            const on = btn.dataset.dcTab === tab;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        document.querySelectorAll('.dc-pane').forEach((pane) => {
            pane.classList.toggle('hidden', pane.dataset.dcPane !== tab);
        });
        if (tab === 'share') renderMyCardQr(readMyCardForm());
        if (tab === 'lock') renderLockPreview();
    }

    async function openPublicCard(slug) {
        document.body.classList.add('is-public-card');
        [scanContent, contactsContent, networkContent, myCardContent].forEach((el) => el?.classList.add('hidden'));
        publicCardContent?.classList.remove('hidden');
        publicCardContent?.classList.add('fade-in');
        chatWindow?.classList.add('hidden');

        let card = null;
        if (navigator.onLine) {
            try {
                const res = await fetch(`${API_URL}/profile/${encodeURIComponent(slug)}`);
                if (res.ok) {
                    const data = await res.json();
                    card = data.profile;
                }
            } catch (err) {
                /* fall back to local */
            }
        }
        if (!card) {
            const local = loadMyCard();
            const localSlug = slugifyCard(local.slug || local.name || userId || TEMP_USER_ID);
            if (localSlug === slug || slug === userId || slug === TEMP_USER_ID) card = local;
        }
        if (!card || !card.name) {
            const sub = document.getElementById('publicCardSub');
            if (sub) sub.textContent = 'This card is not available yet.';
            return;
        }
        publicCardData = { ...card, slug };
        fillDigitalCard(document.getElementById('publicCardPreview'), publicCardData);
        renderMyCardQr(publicCardData, document.getElementById('publicCardQrCanvas'));
        const sub = document.getElementById('publicCardSub');
        if (sub) sub.textContent = [card.title, card.company].filter(Boolean).join(' · ') || 'Save this contact to your phone';
    }

    document.querySelectorAll('.dc-tab').forEach((btn) => {
        btn.addEventListener('click', () => switchDcTab(btn.dataset.dcTab));
    });

    MY_CARD_FIELD_IDS.forEach((id) => {
        document.getElementById(id)?.addEventListener('input', () => {
            window.clearTimeout(myCardSyncTimer);
            myCardSyncTimer = window.setTimeout(refreshMyCardPreview, 80);
        });
    });
    document.getElementById('myCardAccent')?.addEventListener('input', refreshMyCardPreview);
    document.querySelectorAll('input[name="myCardQrMode"]').forEach((input) => {
        input.addEventListener('change', refreshMyCardPreview);
    });
    document.querySelectorAll('#myCardThemeRow [data-theme]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const stored = { ...readMyCardForm(), theme: btn.dataset.theme };
            saveMyCard(stored);
            fillMyCardForm(stored);
            refreshMyCardPreview();
        });
    });
    document.querySelectorAll('#myCardLayoutRow [data-layout]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const stored = { ...readMyCardForm(), layout: btn.dataset.layout };
            saveMyCard(stored);
            fillMyCardForm(stored);
            refreshMyCardPreview();
        });
    });
    document.querySelectorAll('#lockTemplateRow [data-lock-template]').forEach((btn) => {
        btn.addEventListener('click', () => {
            lockTemplate = btn.dataset.lockTemplate;
            document.querySelectorAll('#lockTemplateRow [data-lock-template]').forEach((b) => {
                b.classList.toggle('is-active', b === btn);
            });
            renderLockPreview();
        });
    });
    document.getElementById('lockSizeSelect')?.addEventListener('change', renderLockPreview);

    document.getElementById('myCardAvatarBtn')?.addEventListener('click', () => {
        document.getElementById('myCardAvatar')?.click();
    });
    document.getElementById('myCardAvatar')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await compressAvatarFile(file);
            const stored = { ...readMyCardForm(), avatar: dataUrl };
            saveMyCard(stored);
            fillMyCardForm(stored);
            refreshMyCardPreview();
        } catch (err) {
            showToast('Could not use that photo', 'warning');
        }
    });
    document.getElementById('myCardAvatarClear')?.addEventListener('click', () => {
        const stored = { ...readMyCardForm(), avatar: '' };
        saveMyCard(stored);
        fillMyCardForm(stored);
        refreshMyCardPreview();
    });

    myCardBtn?.addEventListener('click', () => switchToTab('mycard'));
    document.getElementById('saveMyCardBtn')?.addEventListener('click', () => persistMyCard(readMyCardForm()));

    document.getElementById('shareMyCardBtn')?.addEventListener('click', async () => {
        const card = readMyCardForm();
        if (!(await persistMyCard(card, { toast: false }))) return;
        const url = myCardPublicUrl(card);
        try {
            if (navigator.share) {
                await navigator.share({ title: card.name || 'My card', text: contactShareText(card), url });
                showToast('Card shared', 'success');
                return;
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return;
        }
        const result = await shareVCardContent(buildVCard({ ...card, profileUrl: url }), card, `${card.name}.vcf`);
        if (result === 'fallback') showToast('Card copied and downloaded', 'success');
        else if (result !== 'aborted') showToast('Card shared', 'success');
    });

    document.getElementById('copyMyCardUrlBtn')?.addEventListener('click', async () => {
        try {
            await copyTextToClipboard(myCardPublicUrl(readMyCardForm()));
            showToast('Link copied', 'success');
        } catch (err) {
            showToast('Clipboard blocked — copy the URL under the QR', 'warning');
        }
    });

    document.getElementById('downloadMyCardVcfBtn')?.addEventListener('click', async () => {
        const card = readMyCardForm();
        if (!card.name) {
            showToast('Add your name before downloading', 'warning');
            return;
        }
        await persistMyCard(card, { toast: false });
        await downloadProfileVcf(card, card.slug);
        showToast('vCard downloaded', 'success');
    });

    document.getElementById('downloadMyCardQrBtn')?.addEventListener('click', () => {
        const canvas = document.getElementById('myCardQrCanvas');
        if (!canvas) return;
        const link = document.createElement('a');
        link.download = 'folio-my-card-qr.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
    });

    document.getElementById('downloadMyCardQrSvgBtn')?.addEventListener('click', () => {
        if (typeof QRCode === 'undefined') return;
        const card = readMyCardForm();
        QRCode.toString(qrPayloadForCard(card), {
            type: 'svg',
            margin: 1,
            color: { dark: '#1B2A4A', light: '#FFFFFF' },
            width: 512,
        }, (err, svg) => {
            if (err) {
                showToast('Could not export SVG', 'warning');
                return;
            }
            downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'folio-my-card-qr.svg');
        });
    });

    document.getElementById('downloadLockBtn')?.addEventListener('click', downloadLockWallpaper);

    document.getElementById('publicSaveVcfBtn')?.addEventListener('click', async () => {
        if (!publicCardData) return;
        await downloadProfileVcf(publicCardData, publicCardData.slug);
        showToast('vCard downloaded', 'success');
    });

    // Register service worker + premium PWA experience (iOS + Android)
    const installAppBtn = document.getElementById('installAppBtn');
    const installSheet = document.getElementById('installSheet');
    const connectivityBar = document.getElementById('connectivityBar');
    const pwaUpdateBar = document.getElementById('pwaUpdateBar');
    let deferredInstallPrompt = null;
    let waitingWorker = null;

    function isStandaloneDisplay() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true
            || document.referrer.includes('android-app://');
    }

    function isIosDevice() {
        return /iphone|ipad|ipod/i.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function dismissBootSplash() {
        const boot = document.getElementById('folioBoot');
        if (!boot || boot.classList.contains('is-done')) return;
        requestAnimationFrame(() => {
            boot.classList.add('is-done');
            setTimeout(() => boot.remove(), 500);
        });
    }

    function showConnectivity(online) {
        if (!connectivityBar) return;
        if (online) {
            connectivityBar.textContent = 'Back online';
            connectivityBar.classList.remove('hidden', 'is-offline');
            connectivityBar.classList.add('is-online');
            setTimeout(() => connectivityBar.classList.add('hidden'), 2200);
            document.body.classList.remove('is-offline');
        } else {
            connectivityBar.textContent = 'Offline — showing cached contacts when available';
            connectivityBar.classList.remove('hidden', 'is-online');
            connectivityBar.classList.add('is-offline');
            document.body.classList.add('is-offline');
        }
    }

    function openInstallSheet() {
        if (!installSheet) return;
        const androidBlock = document.getElementById('installAndroidBlock');
        const iosBlock = document.getElementById('installIosBlock');
        const desktopBlock = document.getElementById('installDesktopBlock');
        androidBlock?.classList.add('hidden');
        iosBlock?.classList.add('hidden');
        desktopBlock?.classList.add('hidden');

        if (isIosDevice() && !isStandaloneDisplay()) {
            iosBlock?.classList.remove('hidden');
        } else if (deferredInstallPrompt) {
            androidBlock?.classList.remove('hidden');
        } else {
            desktopBlock?.classList.remove('hidden');
        }
        installSheet.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeInstallSheet() {
        installSheet?.classList.add('hidden');
        document.body.style.overflow = '';
    }

    async function promptNativeInstall() {
        if (!deferredInstallPrompt) {
            openInstallSheet();
            return;
        }
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        installAppBtn?.classList.add('hidden');
        closeInstallSheet();
        if (choice.outcome === 'accepted') {
            showToast('Folio installed', 'success');
        }
    }

    if (isStandaloneDisplay()) {
        document.body.classList.add('is-standalone');
        installAppBtn?.classList.add('hidden');
    } else {
        // Show install affordance after a short delay (premium, not pushy)
        setTimeout(() => {
            if (isStandaloneDisplay()) return;
            const dismissed = localStorage.getItem('folio_install_dismissed');
            if (dismissed && Date.now() - Number(dismissed) < 7 * 86400000) return;
            installAppBtn?.classList.remove('hidden');
        }, 1800);
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (!isStandaloneDisplay()) {
            installAppBtn?.classList.remove('hidden');
        }
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        installAppBtn?.classList.add('hidden');
        closeInstallSheet();
        localStorage.setItem('folio_install_dismissed', String(Date.now()));
        showToast('Folio is on your home screen', 'success');
    });

    installAppBtn?.addEventListener('click', openInstallSheet);
    document.getElementById('closeInstallSheet')?.addEventListener('click', () => {
        localStorage.setItem('folio_install_dismissed', String(Date.now()));
        closeInstallSheet();
    });
    installSheet?.addEventListener('click', (e) => {
        if (e.target === installSheet) closeInstallSheet();
    });
    document.getElementById('confirmInstallBtn')?.addEventListener('click', promptNativeInstall);
    document.getElementById('confirmInstallDesktopBtn')?.addEventListener('click', promptNativeInstall);

    window.addEventListener('online', () => showConnectivity(true));
    window.addEventListener('offline', () => showConnectivity(false));
    if (!navigator.onLine) showConnectivity(false);

    // Deep links from manifest shortcuts
    try {
        const params = new URLSearchParams(window.location.search);
        const view = params.get('view');
        const cardSlug = params.get('card');
        if (cardSlug) {
            setTimeout(() => openPublicCard(cardSlug), 50);
        } else if (view === 'contacts' || view === 'scan' || view === 'network' || view === 'mycard') {
            setTimeout(() => switchToTab(view), 50);
        }
    } catch (e) { /* ignore */ }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js?v=10').then((reg) => {
            const showUpdate = (worker) => {
                waitingWorker = worker;
                pwaUpdateBar?.classList.remove('hidden');
            };

            if (reg.waiting) showUpdate(reg.waiting);

            reg.addEventListener('updatefound', () => {
                const worker = reg.installing;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        showUpdate(worker);
                    }
                });
            });

            // Periodic update check while app is open
            setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
        }).catch((err) => {
            console.warn('Service worker registration failed:', err);
        });

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            // Reloaded after SKIP_WAITING
        });

        document.getElementById('pwaRefreshBtn')?.addEventListener('click', () => {
            if (waitingWorker) {
                waitingWorker.postMessage({ type: 'SKIP_WAITING' });
            }
            window.location.reload();
        });
    }

    // Boot splash: keep until auth restore finishes (fallback max wait)
    window.addEventListener('load', () => {
        if (authReady) dismissBootSplash();
    });
    setTimeout(() => {
        if (!authReady) setBootStatus('Still connecting…');
    }, 4000);
    setTimeout(dismissBootSplash, 15000);
});