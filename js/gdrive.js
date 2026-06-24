// ================= GOOGLE DRIVE BACKUP & SYNC MODULE (gdrive.js) =================

const gdriveService = {
    // Default Client ID for localhost:8080 (You can override this in settings)
    DEFAULT_CLIENT_ID: '938090708516-h6rpnpsf52k7d1u4kfqc0p953tkl8k5k.apps.googleusercontent.com', 
    
    accessToken: null,
    tokenExpiry: null,
    userInfo: null,
    backupFileId: null,
    autoBackupInterval: null,

    // Initialize Service: Check url hash for OAuth redirect token
    async init() {
        // Load saved token if valid
        const savedToken = await settingsDb.get('gdriveAccessToken', '');
        const savedExpiry = await settingsDb.get('gdriveTokenExpiry', 0);
        
        if (savedToken && savedExpiry > Date.now()) {
            this.accessToken = savedToken;
            this.tokenExpiry = savedExpiry;
            await this.loadUserInfo();
            this.startPeriodicAutoBackup();
        } else {
            // Clean expired token
            this.clearToken();
        }

        // Handle OAuth Redirect Hash
        await this.handleOAuthRedirect();
    },

    // Check if user is authenticated
    isAuthenticated() {
        return this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now();
    },

    // Start OAuth Implicit Flow Redirect
    async connect() {
        const clientIdInput = document.getElementById('gdrive-client-id');
        let clientId = clientIdInput ? clientIdInput.value.trim() : '';
        if (!clientId) {
            clientId = this.DEFAULT_CLIENT_ID;
        }

        // Save Client ID for reuse
        await settingsDb.set('gdriveClientId', clientId);

        const redirectUri = window.location.origin + window.location.pathname;
        const scope = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
        
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth` +
            `?client_id=${encodeURIComponent(clientId)}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=token` +
            `&scope=${encodeURIComponent(scope)}` +
            `&state=gdrive_sync`;
            
        // Redirect to Google Login
        window.location.href = authUrl;
    },

    // Disconnect Google Account
    async disconnect() {
        this.clearToken();
        if (this.autoBackupInterval) {
            clearInterval(this.autoBackupInterval);
            this.autoBackupInterval = null;
        }
        await settingsDb.set('gdriveAccessToken', '');
        await settingsDb.set('gdriveTokenExpiry', 0);
        this.updateUI();
    },

    clearToken() {
        this.accessToken = null;
        this.tokenExpiry = null;
        this.userInfo = null;
        this.backupFileId = null;
    },

    // Parse OAuth response from URL Hash
    async handleOAuthRedirect() {
        const hash = window.location.hash;
        if (hash && hash.includes('access_token=')) {
            const params = new URLSearchParams(hash.substring(1));
            const token = params.get('access_token');
            const expiresIn = parseInt(params.get('expires_in')) || 3600;
            const state = params.get('state');

            if (token && state === 'gdrive_sync') {
                this.accessToken = token;
                this.tokenExpiry = Date.now() + (expiresIn * 1000);

                // Save to local storage
                await settingsDb.set('gdriveAccessToken', this.accessToken);
                await settingsDb.set('gdriveTokenExpiry', this.tokenExpiry);

                // Clean the hash from the browser URL bar
                window.history.replaceState(null, null, window.location.pathname + window.location.search);

                // Load User details
                await this.loadUserInfo();
                
                // Show sync UI tab
                if (window.app) {
                    window.app.switchView('view-profile');
                    // Trigger segment switch to Account
                    const accountBtn = document.querySelector('.segment-btn[data-segment="profile-account"]');
                    if (accountBtn) accountBtn.click();
                }

                // Bağlantı kurulduğunda verileri otomatik eşitle
                await this.autoSyncOnConnect();
            }
        }
    },

    // Fetch Google User Profile details
    async loadUserInfo() {
        if (!this.accessToken) return;

        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (response.ok) {
                this.userInfo = await response.json();
                this.updateUI();
                this.startPeriodicAutoBackup();
            } else {
                throw new Error("Profil yüklenemedi.");
            }
        } catch (e) {
            console.error("User profile load failed:", e);
            this.disconnect();
        }
    },

    // Google Drive bağlandığı an çalışan otomatik veri senkronizasyonu
    async autoSyncOnConnect() {
        try {
            console.log("AutoSync: Checking for existing backup on Google Drive...");
            const fileId = await this.findBackupFile();
            
            if (fileId) {
                // Drive'da yedek dosyası mevcut!
                console.log("AutoSync: Backup found on Drive. Downloading and restoring...");
                
                const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${this.accessToken}` }
                });

                if (response.ok) {
                    const backupData = await response.json();
                    
                    if (backupData.app === "EndlessR") {
                        // GDrive bağlantı ayarlarını korumak için yedekle
                        const keysToKeep = {
                            gdriveAccessToken: await settingsDb.get('gdriveAccessToken', ''),
                            gdriveTokenExpiry: await settingsDb.get('gdriveTokenExpiry', 0),
                            gdriveClientId: await settingsDb.get('gdriveClientId', ''),
                            gdriveAutoSync: await settingsDb.get('gdriveAutoSync', true),
                            gdriveLastBackupTime: await settingsDb.get('gdriveLastBackupTime', 'Bilinmiyor')
                        };

                        // Yerel IndexedDB veritabanlarını tamamen sıfırla (Drive verisini baz almak için)
                        await db.words.clear();
                        await db.replacements.clear();
                        await db.books.clear();
                        await db.settings.clear();

                        // Drive bağlantı ayarlarını geri yaz
                        for (const [k, v] of Object.entries(keysToKeep)) {
                            await db.settings.setItem(k, v);
                        }

                        // 1. Kelimeleri Geri Yükle
                        if (backupData.words && Array.isArray(backupData.words)) {
                            for (const word of backupData.words) {
                                await db.words.setItem(word.id, word);
                            }
                        }

                        // 2. Değişiklikleri Geri Yükle
                        if (backupData.replacements && Array.isArray(backupData.replacements)) {
                            for (const rep of backupData.replacements) {
                                await db.replacements.setItem(rep.id, rep);
                            }
                        }

                        // 3. Genel Ayarları Geri Yükle
                        if (backupData.settings && typeof backupData.settings === 'object') {
                            for (const [key, val] of Object.entries(backupData.settings)) {
                                if (!Object.keys(keysToKeep).includes(key)) {
                                    await db.settings.setItem(key, val);
                                }
                            }
                        }

                        // 4. Kitapları (dosya içeriği ve ilerlemeler dahil) Geri Yükle
                        if (backupData.books && Array.isArray(backupData.books)) {
                            for (const book of backupData.books) {
                                const restoredBook = { ...book };
                                if (book.file && typeof book.file === 'string') {
                                    restoredBook.file = base64ToArrayBuffer(book.file);
                                }
                                await db.books.setItem(book.id, restoredBook);
                            }
                        }

                        alert("Google Drive bağlantısı kuruldu! Buluttaki yedeğiniz tespit edildi ve yerel kütüphaneniz bulut verileriyle senkronize edildi.");
                        window.location.reload();
                        return;
                    }
                }
                throw new Error("Yedek dosyası indirilemedi veya geçersiz.");
            } else {
                // Drive'da yedek dosyası yok! Bu ilk bağlantıdır, yerel verileri buluta yükle.
                console.log("AutoSync: No backup found on Drive. Uploading current local data as initial backup...");
                await this.performBackup(true);
                alert("Google Drive bağlantısı kuruldu! Bulutta yedek bulunamadı. Mevcut yerel verileriniz ilk yedek olarak buluta yüklendi.");
            }
        } catch (e) {
            console.error("AutoSync failed:", e);
            alert("Google Drive bağlantısı kuruldu fakat otomatik veri eşitlemesi esnasında hata oluştu: " + e.message);
        }
    },

    // Update UI controls dynamically
    async updateUI() {
        const discCard = document.getElementById('gdrive-disconnected-state');
        const connCard = document.getElementById('gdrive-connected-state');
        const clientIdInput = document.getElementById('gdrive-client-id');
        
        const accountDesc = document.getElementById('profile-account-desc');
        const accountType = document.getElementById('profile-account-type');
        const autoSyncCheckbox = document.getElementById('gdrive-auto-sync');

        if (clientIdInput) {
            clientIdInput.value = await settingsDb.get('gdriveClientId', this.DEFAULT_CLIENT_ID);
        }

        if (this.isAuthenticated() && this.userInfo) {
            if (discCard) discCard.style.display = 'none';
            if (connCard) connCard.style.display = 'flex';

            // Set user data
            const nameEl = document.getElementById('gdrive-user-name');
            const emailEl = document.getElementById('gdrive-user-email');
            const avatarEl = document.getElementById('gdrive-user-avatar');
            const placeholderEl = document.getElementById('gdrive-user-avatar-placeholder');

            if (nameEl) nameEl.textContent = this.userInfo.name || 'Google Kullanıcısı';
            if (emailEl) emailEl.textContent = this.userInfo.email || '';
            
            if (this.userInfo.picture) {
                if (avatarEl) {
                    avatarEl.src = this.userInfo.picture;
                    avatarEl.style.display = 'block';
                }
                if (placeholderEl) placeholderEl.style.display = 'none';
            } else {
                if (avatarEl) avatarEl.style.display = 'none';
                if (placeholderEl) {
                    placeholderEl.style.display = 'flex';
                    placeholderEl.textContent = (this.userInfo.name || 'G').charAt(0).toUpperCase();
                }
            }

            // Load last backup timestamp
            const lastBackup = await settingsDb.get('gdriveLastBackupTime', 'Bilinmiyor');
            const statusEl = document.getElementById('gdrive-status-message');
            if (statusEl) statusEl.textContent = `Son yedekleme: ${lastBackup}`;

            // Update top details section to reflect Google status
            if (accountDesc) accountDesc.textContent = "Google Drive ile bulut eşitlemesi aktif.";
            if (accountType) {
                accountType.value = `Google Bulut Hesabı (${this.userInfo.email || 'Aktif'})`;
                accountType.style.background = 'rgba(50, 146, 255, 0.08)';
                accountType.style.borderColor = 'rgba(50, 146, 255, 0.2)';
                accountType.style.color = 'var(--accent-color)';
            }

            // Set Auto-Sync checkbox state
            if (autoSyncCheckbox) {
                autoSyncCheckbox.checked = await settingsDb.get('gdriveAutoSync', true);
            }

        } else {
            if (discCard) discCard.style.display = 'flex';
            if (connCard) connCard.style.display = 'none';

            // Restore top details section to Local status
            if (accountDesc) accountDesc.textContent = "Yerel hesap durumu bilgileri aşağıdadır.";
            if (accountType) {
                accountType.value = "Standart Çevrimdışı Kullanıcı";
                accountType.style.background = 'rgba(0,0,0,0.05)';
                accountType.style.borderColor = 'var(--border-color)';
                accountType.style.color = 'var(--text-secondary)';
            }
        }
    },

    // Find the backup file on Drive
    async findBackupFile() {
        if (!this.accessToken) return null;

        try {
            const query = encodeURIComponent("name = 'endlessr_backup.json' and trashed = false");
            const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive`, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (response.ok) {
                const data = await response.json();
                if (data.files && data.files.length > 0) {
                    this.backupFileId = data.files[0].id;
                    return this.backupFileId;
                }
            }
        } catch (e) {
            console.error("Backup search failed:", e);
        }
        return null;
    },

    // Create or Update backup file on Drive
    async performBackup(isSilent = false) {
        if (!this.isAuthenticated()) {
            if (!isSilent) alert("Lütfen önce Google hesabınızı bağlayın.");
            return;
        }

        const backupBtn = document.getElementById('btn-gdrive-backup');
        const statusEl = document.getElementById('gdrive-status-message');

        if (!isSilent && backupBtn) {
            backupBtn.disabled = true;
            backupBtn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> Yedekleniyor...';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } else if (isSilent && statusEl) {
            statusEl.textContent = "Otomatik yedekleniyor...";
        }

        try {
            // Collect Database items
            const allWords = await wordsDb.getAllWords();
            const allReplacements = await replacementsDb.getAllReplacements();
            
            // Collect settings (excluding auth details)
            const keysToExclude = ['gdriveAccessToken', 'gdriveTokenExpiry'];
            const allSettings = {};
            const settingKeys = await db.settings.keys();
            for (const key of settingKeys) {
                if (!keysToExclude.includes(key)) {
                    allSettings[key] = await db.settings.getItem(key);
                }
            }

            // Collect book reading progress metadata
            const allBooksMetadata = await booksDb.getAllBooks();

            // Collect full books (including file data converted to base64)
            const allBooksFull = [];
            const bookKeys = await db.books.keys();
            for (const key of bookKeys) {
                const book = await db.books.getItem(key);
                if (book) {
                    let base64File = null;
                    if (book.file) {
                        base64File = await arrayBufferToBase64Async(book.file);
                    }
                    allBooksFull.push({
                        ...book,
                        file: base64File // Overwrite ArrayBuffer with base64 string
                    });
                }
            }

            const backupData = {
                app: "EndlessR",
                version: "1.0",
                exportedAt: Date.now(),
                words: allWords,
                replacements: allReplacements,
                settings: allSettings,
                booksMetadata: allBooksMetadata, // Keep for backward compatibility
                books: allBooksFull
            };

            const fileId = await this.findBackupFile();
            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
            
            let uploadUrl;
            if (fileId) {
                // Update Existing file: Start resumable session
                const initResponse = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json; charset=UTF-8'
                    },
                    body: JSON.stringify({
                        name: 'endlessr_backup.json'
                    })
                });
                if (!initResponse.ok) {
                    const errText = await initResponse.text();
                    throw new Error("Yedek güncelleme oturumu başlatılamadı: " + errText);
                }
                uploadUrl = initResponse.headers.get('Location');
            } else {
                // Create New file: Start resumable session
                const initResponse = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json; charset=UTF-8'
                    },
                    body: JSON.stringify({
                        name: 'endlessr_backup.json',
                        mimeType: 'application/json'
                    })
                });
                if (!initResponse.ok) {
                    const errText = await initResponse.text();
                    throw new Error("Yedek oluşturma oturumu başlatılamadı: " + errText);
                }
                uploadUrl = initResponse.headers.get('Location');
            }

            if (!uploadUrl) {
                throw new Error("Google Drive yükleme adresi alınamadı (Location header eksik).");
            }

            // Perform the actual upload PUT request
            const response = await fetch(uploadUrl, {
                method: 'PUT',
                body: blob
            });

            if (response.ok) {
                const nowStr = new Date().toLocaleString('tr-TR');
                await settingsDb.set('gdriveLastBackupTime', nowStr);
                this.updateUI();
                if (!isSilent) {
                    alert("Verileriniz Google Drive'a başarıyla yedeklendi!");
                }
            } else {
                const errText = await response.text();
                throw new Error("Yedek dosyası içeriği yüklenemedi: " + errText);
            }
        } catch (e) {
            console.error("Backup failed:", e);
            if (!isSilent) {
                alert("Yedekleme hatası: " + e.message);
            } else if (statusEl) {
                const lastBackup = await settingsDb.get('gdriveLastBackupTime', 'Bilinmiyor');
                statusEl.textContent = `Otomatik yedekleme başarısız. Son yedek: ${lastBackup}`;
            }
        } finally {
            if (!isSilent && backupBtn) {
                backupBtn.disabled = false;
                backupBtn.innerHTML = '<i data-lucide="cloud-upload"></i> Şimdi Yedekle';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }
    },

    autoBackupTimeout: null,

    // Debounced automatic backup
    scheduleAutoBackup() {
        if (!this.isAuthenticated()) return;

        settingsDb.get('gdriveAutoSync', true).then(enabled => {
            if (!enabled) return;

            if (this.autoBackupTimeout) {
                clearTimeout(this.autoBackupTimeout);
            }

            this.autoBackupTimeout = setTimeout(() => {
                console.log("Auto-sync: Performing automatic backup...");
                this.performBackup(true);
            }, 5000); // 5 seconds debounce
        });
    },

    startPeriodicAutoBackup() {
        if (this.autoBackupInterval) {
            clearInterval(this.autoBackupInterval);
        }
        this.autoBackupInterval = setInterval(() => {
            settingsDb.get('gdriveAutoSync', true).then(enabled => {
                if (enabled && this.isAuthenticated()) {
                    console.log("Periodic auto-sync: Performing backup...");
                    this.performBackup(true);
                }
            });
        }, 5 * 60 * 1000); // 5 minutes
    },

    // Download and restore backup data from Drive
    async performRestore() {
        if (!this.isAuthenticated()) {
            alert("Lütfen önce Google hesabınızı bağlayın.");
            return;
        }

        if (!confirm("Google Drive'daki yedeği geri yüklemek istediğinize emin misiniz? Bu işlem yerel sözlük, ayarlar ve kitap ilerlemelerinizi sıfırlayıp buluttaki verilerinizle değiştirecektir!")) {
            return;
        }

        const restoreBtn = document.getElementById('btn-gdrive-restore');
        if (restoreBtn) {
            restoreBtn.disabled = true;
            restoreBtn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> Yükleniyor...';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }

        try {
            const fileId = await this.findBackupFile();
            if (!fileId) {
                alert("Google Drive'da herhangi bir yedek dosyası bulunamadı.");
                return;
            }

            const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });

            if (response.ok) {
                const backupData = await response.json();
                
                if (backupData.app !== "EndlessR") {
                    throw new Error("Geçersiz yedek dosyası formatı.");
                }

                // 1. Restore Words
                await db.words.clear();
                if (backupData.words && Array.isArray(backupData.words)) {
                    for (const word of backupData.words) {
                        await db.words.setItem(word.id, word);
                    }
                }

                // 2. Restore Replacements
                await db.replacements.clear();
                if (backupData.replacements && Array.isArray(backupData.replacements)) {
                    for (const rep of backupData.replacements) {
                        await db.replacements.setItem(rep.id, rep);
                    }
                }

                // 3. Restore Settings
                if (backupData.settings && typeof backupData.settings === 'object') {
                    for (const [key, val] of Object.entries(backupData.settings)) {
                        await db.settings.setItem(key, val);
                    }
                }

                // 4. Restore Books (including file content and progress)
                if (backupData.books && Array.isArray(backupData.books)) {
                    for (const book of backupData.books) {
                        const restoredBook = { ...book };
                        if (book.file && typeof book.file === 'string') {
                            restoredBook.file = base64ToArrayBuffer(book.file);
                        }
                        await db.books.setItem(book.id, restoredBook);
                    }
                } else if (backupData.booksMetadata && Array.isArray(backupData.booksMetadata)) {
                    // Fallback to old behavior if restoring from an older backup
                    for (const bookMeta of backupData.booksMetadata) {
                        const existingBookObj = await db.books.getItem(bookMeta.id);
                        if (existingBookObj) {
                            existingBookObj.progressPercent = bookMeta.progressPercent;
                            existingBookObj.lastLocation = bookMeta.lastLocation;
                            existingBookObj.lastReadAt = bookMeta.lastReadAt;
                            await db.books.setItem(bookMeta.id, existingBookObj);
                        }
                    }
                }

                alert("Verileriniz Google Drive yedeğinden başarıyla geri yüklendi! Değişikliklerin uygulanması için sayfa yenilenecektir.");
                window.location.reload();

            } else {
                throw new Error("Dosya indirme başarısız.");
            }
        } catch (e) {
            console.error("Restore failed:", e);
            alert("Geri yükleme hatası: " + e.message);
        } finally {
            if (restoreBtn) {
                restoreBtn.disabled = false;
                restoreBtn.innerHTML = '<i data-lucide="cloud-download"></i> Geri Yükle';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }
    }
};

// Helper to convert ArrayBuffer to Base64 asynchronously
function arrayBufferToBase64Async(buffer) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const reader = new FileReader();
        reader.onload = function(e) {
            const dataUrl = e.target.result;
            const base64 = dataUrl.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Helper to convert Base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}
