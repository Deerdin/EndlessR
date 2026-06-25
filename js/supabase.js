// ================= SUPABASE BULUT SYNC MODULE (supabase.js) =================

const supabaseService = {
    URL: "https://fiskjbvryyhuqyvptzuh.supabase.co",
    KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpc2tqYnZyeXlodXF5dnB0enVoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNzY5OTEsImV4cCI6MjA5Nzk1Mjk5MX0.2fTStpyB4dKVGtFLOsTVIGi1DZATNgRPSwaJ97qpX4Q",
    
    client: null,
    session: null,
    autoBackupInterval: null,
    autoBackupTimeout: null,
    isBackingUp: false,

    async init() {
        // Initialize Supabase Client
        if (typeof supabase !== 'undefined') {
            this.client = supabase.createClient(this.URL, this.KEY);
            
            // Listen for auth state changes (automatically handles refresh tokens!)
            this.client.auth.onAuthStateChange(async (event, session) => {
                console.log("Supabase Auth Event:", event);
                this.session = session;
                this.updateUI();

                if (session) {
                    this.startPeriodicAutoBackup();
                } else {
                    if (this.autoBackupInterval) {
                        clearInterval(this.autoBackupInterval);
                        this.autoBackupInterval = null;
                    }
                }
            });

            // Restore active session
            const { data } = await this.client.auth.getSession();
            this.session = data.session;
            this.updateUI();
            if (this.session) {
                this.startPeriodicAutoBackup();
            }
        } else {
            console.error("Supabase SDK is not loaded.");
        }
    },

    isAuthenticated() {
        return this.session !== null;
    },

    getUserEmail() {
        return this.session && this.session.user ? this.session.user.email : '';
    },

    getUserId() {
        return this.session && this.session.user ? this.session.user.id : null;
    },

    // Login with Email/Password
    async login(email, password) {
        if (!this.client) return { error: "Supabase istemcisi yüklenemedi." };
        
        try {
            const { data, error } = await this.client.auth.signInWithPassword({ email, password });
            if (error) throw error;
            
            this.session = data.session;
            await this.autoSyncOnConnect();
            return { success: true };
        } catch (e) {
            console.error("Login failed:", e);
            return { error: e.message };
        }
    },

    // Register with Email/Password
    async register(email, password) {
        if (!this.client) return { error: "Supabase istemcisi yüklenemedi." };
        
        try {
            const { data, error } = await this.client.auth.signUp({ email, password });
            if (error) throw error;
            
            alert("Kayıt başarılı! Giriş yapmayı deneyebilirsiniz. Eğer giriş esnasında doğrulama hatası alırsanız ve mailinize gelen doğrulama linki çalışmazsa (localhost sunucumuza yönlendirdiği için), lütfen Supabase panelinizden 'Authentication -> Settings -> Providers -> Email -> Confirm email' seçeneğini devre dışı bırakın. Bu sayede doğrulama e-postası gerekmeden anında giriş yapabilirsiniz.");
            return { success: true };
        } catch (e) {
            console.error("Registration failed:", e);
            return { error: e.message };
        }
    },

    // Disconnect (Logout)
    async disconnect() {
        if (!this.client) return;
        
        try {
            await this.client.auth.signOut();
            this.session = null;
            if (this.autoBackupInterval) {
                clearInterval(this.autoBackupInterval);
                this.autoBackupInterval = null;
            }
            this.updateUI();
            window.location.reload();
        } catch (e) {
            console.error("Logout failed:", e);
        }
    },

    // Auto sync logic on connect
    async autoSyncOnConnect() {
        try {
            const userId = this.getUserId();
            if (!userId) return;

            console.log("Supabase Sync: Checking for existing backup in Storage...");
            
            // Check if backup.json exists in backups bucket
            const { data: fileBlob, error } = await this.client.storage
                .from('backups')
                .download(`${userId}/backup.json`);

            if (fileBlob && !error) {
                console.log("Supabase Sync: Backup found. Restoring...");
                const backupText = await fileBlob.text();
                const backupData = JSON.parse(backupText);

                if (backupData.app === "EndlessR") {
                    // Clean databases
                    await db.words.clear();
                    await db.replacements.clear();
                    await db.books.clear();
                    await db.settings.clear();

                    // Restore words
                    if (backupData.words && Array.isArray(backupData.words)) {
                        for (const word of backupData.words) {
                            await db.words.setItem(word.id, word);
                        }
                    }

                    // Restore replacements
                    if (backupData.replacements && Array.isArray(backupData.replacements)) {
                        for (const rep of backupData.replacements) {
                            await db.replacements.setItem(rep.id, rep);
                        }
                    }

                    // Restore settings
                    if (backupData.settings && typeof backupData.settings === 'object') {
                        for (const [key, val] of Object.entries(backupData.settings)) {
                            await db.settings.setItem(key, val);
                        }
                    }

                    // Restore books
                    if (backupData.books && Array.isArray(backupData.books)) {
                        for (const book of backupData.books) {
                            const restoredBook = { ...book };
                            if (book.file && typeof book.file === 'string') {
                                restoredBook.file = base64ToArrayBuffer(book.file);
                            } else {
                                restoredBook.file = null;
                            }
                            await db.books.setItem(book.id, restoredBook);
                        }
                    }

                    alert("Giriş yapıldı! Buluttaki yedeğiniz indirildi ve kütüphaneniz eşitlendi.");
                    window.location.reload();
                    return;
                }
            }
            
            // Backup not found, upload local database
            console.log("Supabase Sync: No backup found. Uploading current local data...");
            await this.performBackup(true);
            alert("Giriş yapıldı! Bulutta yedek bulunamadı. Mevcut yerel verileriniz ilk yedek olarak buluta yüklendi.");
        } catch (e) {
            console.error("AutoSyncOnConnect failed:", e);
            alert("Giriş yapıldı fakat otomatik veri eşitlemesi esnasında hata oluştu: " + e.message);
        }
    },

    // Create or update backup
    async performBackup(isSilent = false) {
        if (!this.isAuthenticated()) {
            if (!isSilent) alert("Lütfen önce oturum açın.");
            return;
        }

        if (this.isBackingUp) {
            console.log("performBackup: Already backing up, skipping.");
            return;
        }
        this.isBackingUp = true;

        const backupBtn = document.getElementById('btn-supabase-backup');
        const statusEl = document.getElementById('supabase-status-message');

        if (!isSilent && backupBtn) {
            backupBtn.disabled = true;
            backupBtn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> Yedekleniyor...';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        } else if (isSilent && statusEl) {
            statusEl.textContent = "Otomatik yedekleniyor...";
        }

        try {
            const allWords = await wordsDb.getAllWords();
            const allReplacements = await replacementsDb.getAllReplacements();
            
            const keysToExclude = ['gdriveAccessToken', 'gdriveTokenExpiry', 'gdriveBackupFileId', 'gdriveFolderId'];
            const allSettings = {};
            const settingKeys = await db.settings.keys();
            for (const key of settingKeys) {
                if (!keysToExclude.includes(key)) {
                    allSettings[key] = await db.settings.getItem(key);
                }
            }

            const allBooksMetadata = await booksDb.getAllBooks();

            const allBooksFull = [];
            const bookKeys = await db.books.keys();
            for (const key of bookKeys) {
                const book = await db.books.getItem(key);
                if (book) {
                    let base64File = null;
                    if (book.isFavorite && book.file) {
                        base64File = await arrayBufferToBase64Async(book.file);
                    }
                    allBooksFull.push({
                        ...book,
                        file: base64File
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
                booksMetadata: allBooksMetadata,
                books: allBooksFull
            };

            const userId = this.getUserId();
            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });

            // Upload or replace using upsert: true
            const { error } = await this.client.storage
                .from('backups')
                .upload(`${userId}/backup.json`, blob, {
                    contentType: 'application/json',
                    upsert: true
                });

            if (error) throw error;

            const nowStr = new Date().toLocaleString('tr-TR');
            await settingsDb.set('supabaseLastBackupTime', nowStr);
            
            this.updateUI();
            if (!isSilent) {
                alert("Verileriniz Supabase bulut veritabanına başarıyla yedeklendi!");
            }
        } catch (e) {
            console.error("Backup failed:", e);
            let userFriendlyMsg = e.message || "Bilinmeyen bir hata oluştu.";
            if (userFriendlyMsg.includes("bucket") || userFriendlyMsg.includes("not_found") || userFriendlyMsg.includes("not found")) {
                userFriendlyMsg = "Supabase Storage panelinizde 'backups' adında özel (private) bir klasör/bucket bulunamadı. Lütfen Supabase Storage panelinde 'backups' adında bir bucket oluşturun ve RLS politikalarından oturum açmış (authenticated) kullanıcılara yazma/okuma izni verin.";
            } else if (userFriendlyMsg.includes("policy") || userFriendlyMsg.includes("row-level-security") || userFriendlyMsg.includes("permission") || userFriendlyMsg.includes("Access denied")) {
                userFriendlyMsg = "Supabase Storage RLS politikaları yazmaya izin vermiyor. Lütfen 'backups' bucket'ı için oturum açmış (authenticated) kullanıcılara yükleme/güncelleme (insert/update) izni veren bir RLS politikası tanımlayın.";
            }
            
            if (!isSilent) {
                alert("Yedekleme Hatası: " + userFriendlyMsg);
            } else if (statusEl) {
                const lastBackup = await settingsDb.get('supabaseLastBackupTime', 'Bilinmiyor');
                statusEl.textContent = `Otomatik yedekleme başarısız. Hata: ${userFriendlyMsg.substring(0, 50)}...`;
            }
        } finally {
            this.isBackingUp = false;
            if (!isSilent && backupBtn) {
                backupBtn.disabled = false;
                backupBtn.innerHTML = '<i data-lucide="cloud-upload"></i> Şimdi Yedekle';
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        }
    },

    // Debounced automatic backup
    scheduleAutoBackup() {
        if (!this.isAuthenticated()) return;

        settingsDb.get('supabaseAutoSync', true).then(enabled => {
            if (!enabled) return;

            if (this.autoBackupTimeout) {
                clearTimeout(this.autoBackupTimeout);
            }

            this.autoBackupTimeout = setTimeout(() => {
                console.log("Auto-sync: Performing automatic backup to Supabase...");
                this.performBackup(true);
            }, 5000); // 5 seconds debounce
        });
    },

    startPeriodicAutoBackup() {
        if (this.autoBackupInterval) {
            clearInterval(this.autoBackupInterval);
        }
        this.autoBackupInterval = setInterval(() => {
            settingsDb.get('supabaseAutoSync', true).then(enabled => {
                if (enabled && this.isAuthenticated()) {
                    console.log("Periodic auto-sync: Performing backup to Supabase...");
                    this.performBackup(true);
                }
            });
        }, 5 * 60 * 1000); // 5 minutes
    },

    // Update UI controls
    async updateUI() {
        const discCard = document.getElementById('supabase-disconnected-state');
        const connCard = document.getElementById('supabase-connected-state');
        const emailEl = document.getElementById('supabase-user-email');
        const statusEl = document.getElementById('supabase-status-message');
        const autoSyncCheckbox = document.getElementById('supabase-auto-sync');

        const accountDesc = document.getElementById('profile-account-desc');
        const accountType = document.getElementById('profile-account-type');

        if (this.isAuthenticated()) {
            if (discCard) discCard.style.display = 'none';
            if (connCard) connCard.style.display = 'flex';

            if (emailEl) emailEl.textContent = this.getUserEmail();

            const lastBackup = await settingsDb.get('supabaseLastBackupTime', 'Bilinmiyor');
            if (statusEl) statusEl.textContent = `Son yedekleme: ${lastBackup}`;

            if (accountDesc) accountDesc.textContent = "Supabase ile bulut eşitlemesi aktif.";
            if (accountType) {
                accountType.value = `Bulut Hesabı (${this.getUserEmail()})`;
                accountType.style.background = 'rgba(124, 58, 237, 0.08)';
                accountType.style.borderColor = 'rgba(124, 58, 237, 0.2)';
                accountType.style.color = 'var(--accent-color)';
            }

            if (autoSyncCheckbox) {
                autoSyncCheckbox.checked = await settingsDb.get('supabaseAutoSync', true);
            }
        } else {
            if (discCard) discCard.style.display = 'flex';
            if (connCard) connCard.style.display = 'none';

            if (accountDesc) accountDesc.textContent = "Yerel hesap durumu bilgileri aşağıdadır.";
            if (accountType) {
                accountType.value = "Standart Çevrimdışı Kullanıcı";
                accountType.style.background = 'rgba(0,0,0,0.05)';
                accountType.style.borderColor = 'var(--border-color)';
                accountType.style.color = 'var(--text-secondary)';
            }
        }
    }
};

// Helper: ArrayBuffer to Base64 (async)
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

// Helper: Base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}
