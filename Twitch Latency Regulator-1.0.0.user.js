// ==UserScript==
// @name         Twitch Latency Regulator
// @namespace    https://www.twitch.tv/pauloman182
// @version      1.0.0
// @description  Régule le buffer pour optimiser la latence, affiche la latence diffuseur, panneau de contrôle, playbackRate affiché et graphique
// @author       pauloman182
// @match        https://www.twitch.tv/*
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    // Configurations par défaut pour chaque mode
    const defaultConfig = {
        low: {
            targetLatency: 0.7,
            Kp: 0.3,
            maxBufferThreshold: 2.0,
            checkInterval: 500,
            maxRate: 3.0,
            minRate: 0.9,
            deadZone: 0.5
        },
        normal: {
            targetLatency: 5.0, // Valeur différente pour latence normale
            Kp: 0.3,
            maxBufferThreshold: 10.0,
            checkInterval: 500,
            maxRate: 3.0,
            minRate: 0.9,
            deadZone: 1.0
        }
    };

    let config = {};
    let currentMode = 'normal'; // Mode par défaut
    let BUFFER_MAX_THRESHOLD = 0;

    let pidInterval = null;
    let latencyGraph = null;
    let controlPanel = null;
    let currentVideo = null;
    let videoStatsDiv = null;
    let areStatsVisible = false;
    let updateControlInputs = null; // Fonction pour mettre à jour les inputs

    let bufferSpikeDetected = false;
    let isMaximized = false;
    let isInDeadZone = false; // Nouvelle variable pour suivre l'état de la dead zone

    const log = (...args) => console.log('[TwitchPID]', ...args);
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

    // Charger la configuration pour le mode actuel
    function loadConfig(mode) {
        console.log(`chargement de la config ${mode}`);
        const key = `twitchPIDConfig_${mode}`;
        const saved = localStorage.getItem(key);
        return saved ? { ...defaultConfig[mode], ...JSON.parse(saved) } : { ...defaultConfig[mode] };
    }

    // Sauvegarder la configuration pour le mode actuel
    function saveConfig(mode) {
        const key = `twitchPIDConfig_${mode}`;
        localStorage.setItem(key, JSON.stringify(config));
    }

    function cleanup() {
        if (pidInterval) clearInterval(pidInterval), pidInterval = null;
        if (latencyGraph) latencyGraph.remove(), latencyGraph = null;
        if (controlPanel) controlPanel.remove(), controlPanel = null;
        updateControlInputs = null;
        bufferSpikeDetected = false;
        isInDeadZone = false; // Reset de l'état de la dead zone
    }

    function waitForElement(selector) {
        return new Promise(resolve => {
            if (document.querySelector(selector)) {
                return resolve(document.querySelector(selector));
            }
            const observer = new MutationObserver(mutations => {
                if (document.querySelector(selector)) {
                    observer.disconnect();
                    resolve(document.querySelector(selector));
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    async function openVideoStats() {
        const settingsButton = await waitForElement("button[data-a-target='player-settings-button']");
        settingsButton.click();
        const advancedButton = await waitForElement("button[data-a-target='player-settings-menu-item-advanced']");
        advancedButton.click();
        const toggleInput = await waitForElement("div[data-a-target='player-settings-submenu-advanced-video-stats']");
        toggleInput.children[0].click();
        videoStatsDiv = await waitForElement("div[data-a-target='player-overlay-video-stats']");
        videoStatsDiv.style.display = "none";
        areStatsVisible = false;
        settingsButton.click();
    }

    // Fonction pour détecter le mode de latence
    function detectLatencyMode() {
        const modeLatence = document.querySelector("p[aria-label='Mode latence']");
        if (modeLatence) {
            const modeText = modeLatence.textContent.trim().toLowerCase();
            if (modeText.includes('basse')) {
                return 'low';
            } else if (modeText.includes('normale')) {
                return 'normal';
            }
        }else {
            console.log('mode latence PAS DETECTE !!!');
        }
        return 'normal'; // Par défaut
    }
    function waitForVideo() {
        const observer = new MutationObserver(() => {
            const videos = document.querySelectorAll('video');
            const newVideo = Array.from(videos).find(vid => vid.src.includes('twitch.tv')) || videos[0];

            if (newVideo && newVideo !== currentVideo) {
                log('🎥 Nouvelle vidéo détectée');
                cleanup();
                currentVideo = newVideo;
                interceptRateChange(currentVideo);
                openVideoStats();
                startPID(currentVideo);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        const videos = document.querySelectorAll('video');
        const initialVideo = Array.from(videos).find(vid => vid.src.includes('twitch.tv')) || videos[0];

        if (initialVideo && initialVideo !== currentVideo) {
            log('🎥 Vidéo initiale trouvée');
            cleanup();
            currentVideo = initialVideo;
            interceptRateChange(currentVideo);
            startPID(currentVideo);
        } else if (!initialVideo) {
            setTimeout(waitForVideo, 500);
        }
    }

    function interceptRateChange(video) {
        video.addEventListener('ratechange', e => e.stopImmediatePropagation(), true);
    }

    function setPlaybackRate(video, rate) {
        //rate = Math.round(rate*100)/100;
        rate = clamp(rate, config.minRate, config.maxRate);
        if (Math.abs(video.playbackRate - rate) < 0.01) return rate;

        video.playbackRate = rate;

        return rate;
    }

    function checkBufferThreshold(video, bufferMemory) {
        BUFFER_MAX_THRESHOLD = config.maxBufferThreshold;

        if (bufferMemory > BUFFER_MAX_THRESHOLD && !bufferSpikeDetected) {
            log(`🔄 Buffer trop élevé: ${bufferMemory.toFixed(2)}s > ${BUFFER_MAX_THRESHOLD}s - Mode Anti-Spike activé`);
            bufferSpikeDetected = true;

            const bufferedEnd = video.buffered.end(video.buffered.length - 1);
            const optimalTime = bufferedEnd - 0.8*BUFFER_MAX_THRESHOLD;

            if (optimalTime > video.currentTime) {
                video.currentTime = optimalTime;
                log(`⚡ Saut à ${optimalTime.toFixed(2)}s pour réduire le buffer à ${BUFFER_MAX_THRESHOLD}s`);
            }
        }

        if (bufferMemory <= config.targetLatency + 0.2 && bufferSpikeDetected) {
            bufferSpikeDetected = false;
            log('✅ Buffer normalisé - Mode Anti-Spike désactivé');
        }
    }

    function findPlayerInstance(videoElement) {
        if (!videoElement) return null;

        let element = videoElement;
        for (let i = 0; i < 15 && element; i++) {
            const reactKey = Object.keys(element).find(key => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'));
            if (reactKey) {
                let fiber = element[reactKey];
                for (let j = 0; j < 15 && fiber; j++) {
                    if (fiber.stateNode && fiber.stateNode.player) {
                        console.log('[TwitchPID] Player instance found via stateNode.player');
                        return fiber.stateNode.player;
                    }
                    if (fiber.memoizedProps && fiber.memoizedProps.mediaPlayerInstance) {
                        console.log('[TwitchPID] Player instance found via memoizedProps.mediaPlayerInstance');
                        return fiber.memoizedProps.mediaPlayerInstance;
                    }
                    fiber = fiber.return;
                }
            }
            element = element.parentElement;
        }

        console.error('[TwitchPID] Player instance could not be found. Broadcaster latency will be "N/A".');
        return null;
    }

    function startPID(video) {
        // Détecter le mode de latence
        let modeLatence = 'normal';
        config = loadConfig(currentMode);
        BUFFER_MAX_THRESHOLD = config.maxBufferThreshold;

        const {
            updateGraph,
            container,
            rateLabel,
            infoLabel,
            latencyLabel,
            statusLabel,
            toggleButton,
            canvas
        } = createLatencyGraph(video);

        createControlPanel(container, canvas, toggleButton);

        const player = findPlayerInstance(video);

        pidInterval = setInterval(() => {
            currentMode = detectLatencyMode();
            if (!(modeLatence === currentMode)){
                console.log(`mode latence ${currentMode} detecté`);
                modeLatence = currentMode;
                config = loadConfig(currentMode);
                // Reset de l'état de la dead zone lors du changement de mode
                isInDeadZone = false;

                // Mettre à jour les inputs du panneau de contrôle
                if (updateControlInputs) {
                    updateControlInputs();
                }
            }
            if (!video.buffered || video.buffered.length === 0) return;

            const latencyElement = document.querySelector("p[aria-label='Latence diffuseur']");
            if (latencyElement) {
                latencyLabel.textContent = `Latence diffuseur : ${latencyElement.textContent}`;
            }else {
                return;
            }

            const bufferedEnd = video.buffered.end(video.buffered.length - 1);
            const bufferMemory = bufferedEnd - video.currentTime;
            const error = bufferMemory - config.targetLatency;

            checkBufferThreshold(video, bufferMemory);

            updateGraph(bufferMemory);

            infoLabel.textContent = `Mémoire tampon: ${bufferMemory.toFixed(2)}s`;
            rateLabel.textContent = `Vitesse de lecture: x${video.playbackRate.toFixed(2)}`;
            statusLabel.textContent = currentMode === 'low' ? 'Mode: Latence Basse' : 'Mode: Latence Normale';

            if (bufferSpikeDetected) {
                if (bufferMemory > config.targetLatency + 0.1) {
                    setPlaybackRate(video, 2.0);
                }
                return;
            }

            // Nouvelle logique de dead zone
            const deadZoneUpper = config.targetLatency + config.deadZone/2;
            const deadZoneLower = config.targetLatency - config.deadZone/2;

            // Vérifier si on entre dans la dead zone (seulement si on vient d'en dessous de la target)
            if (bufferMemory < config.targetLatency && bufferMemory >= deadZoneLower) {
                if (!isInDeadZone) {
                    isInDeadZone = true;
                    log('🔄 Entrée dans la dead zone');
                }
            } else if (bufferMemory <= deadZoneUpper && isInDeadZone && bufferMemory >= deadZoneLower) {
                // Si on est entré dans la dead zone, on y reste tant qu'on est entre les bornes
                isInDeadZone = true;
                log('🎯 Toujours dans la dead zone');
            } else if (bufferMemory > deadZoneUpper && isInDeadZone) {
                // On sort de la dead zone par le haut
                isInDeadZone = false;
                log('🔄 Sortie de dead zone par le haut');
            } else if (bufferMemory < deadZoneLower && isInDeadZone) {
                // On sort de la dead zone par le bas
                isInDeadZone = false;
                log('🔄 Sortie de dead zone par le bas');
            }

            // Appliquer la logique de contrôle
            if (isInDeadZone) {
                // Dans la dead zone : maintenir le taux à 1.0
                setPlaybackRate(video, 1.0);
                return;
            }

            // En dehors de la dead zone : appliquer le contrôle normal
            const boost = Math.abs(error) > 0.8 ? 1.2 : 1.0;
            const correction = config.Kp * error * boost;
            const newRate = clamp(1.0 + correction, config.minRate, config.maxRate);

            setPlaybackRate(video, newRate);

            if (Math.abs(video.playbackRate - newRate) > 0.01 && bufferMemory > config.targetLatency + 0.1) {
                const targetTime = bufferedEnd - config.targetLatency;
                if (targetTime > video.currentTime) {
                    video.currentTime = targetTime;
                    log(`⏩ Saut à ${targetTime.toFixed(2)}s pour réduire latence`);
                }
            }

        }, config.checkInterval);

        log('🚀 Contrôle proportionnel avec anti-spike démarré');
    }

    function createLatencyGraph(video) {
        const container = document.createElement('div');
        Object.assign(container.style, {
            position: 'fixed',
            top: '10px',
            left: '10px',
            zIndex: 10000,
            background: isMaximized ? '#222' : 'rgba(34, 34, 34, 0.5)',
            border: isMaximized ? '1px solid #555' : 'none',
            borderRadius: '4px',
            boxShadow: isMaximized ? '0 2px 10px rgba(0,0,0,0.5)' : 'none',
            cursor: 'move',
            transition: 'all 0.2s ease',
            minHeight: isMaximized ? '350px' : '70px'
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            padding: '8px 12px',
            background: isMaximized ? '#111' : 'rgba(17, 17, 17, 0.5)',
            borderBottom: isMaximized ? '1px solid #555' : 'none',
            transition: 'all 0.2s ease'
        });

        const infoContainer = document.createElement('div');
        Object.assign(infoContainer.style, {
            display: 'flex',
            gap: '15px',
            fontSize: '14px',
            fontWeight: 'bold',
            flexDirection: 'column',
            flex: '1'
        });

        const infoLabel = document.createElement('div');
        Object.assign(infoLabel.style, { color: '#fff', textShadow: '1px 1px 2px rgba(0,0,0,0.5)' });
        infoLabel.textContent = 'Mémoire tampon: 0.00s';

        const latencyLabel = document.createElement('div');
        Object.assign(latencyLabel.style, {color: '#fff', textShadow: '1px 1px 2px rgba(0,0,0,0.5)'});
        latencyLabel.textContent = 'Latence diffuseur: 0.00s';

        const rateLabel = document.createElement('div');
        Object.assign(rateLabel.style, {
            color: '#fff',
            textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
            display: isMaximized ? 'block' : 'none',
            opacity: isMaximized ? '1' : '0',
            transition: 'opacity 0.2s ease'
        });
        rateLabel.textContent = 'Vitesse de lecture: x1.00';

        const statusLabel = document.createElement('div');
        Object.assign(statusLabel.style, {
            color: '#fff',
            textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
            fontSize: '14px',
            display: isMaximized ? 'block' : 'none',
            opacity: isMaximized ? '1' : '0',
            transition: 'opacity 0.2s ease'
        });
        statusLabel.textContent = 'Mode: Latence Normale';

        // Container pour les boutons
        const buttonsContainer = document.createElement('div');
        Object.assign(buttonsContainer.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            alignItems: 'flex-end'
        });

        const toggleButton = document.createElement('button');
        Object.assign(toggleButton.style, {
            padding: '2px 6px',
            background: '#333',
            color: '#fff',
            border: '1px solid #555',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            minWidth: '20px'
        });
        toggleButton.textContent = isMaximized ? '−' : '+';

        // Ajout du bouton pour toggler les statistiques vidéo
        const statsToggleButton = document.createElement('button');
        Object.assign(statsToggleButton.style, {
            padding: '2px 6px',
            background: '#333',
            color: '#fff',
            border: '1px solid #555',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '10px',
            display: isMaximized ? 'block' : 'none',
            opacity: isMaximized ? '1' : '0',
            transition: 'opacity 0.2s ease'
        });
        statsToggleButton.textContent = 'Stats';
        statsToggleButton.addEventListener('click', () => {
            if (videoStatsDiv) {
                if (areStatsVisible) {
                    videoStatsDiv.style.display = 'none';
                    statsToggleButton.textContent = 'Stats';
                    areStatsVisible = false;
                } else {
                    videoStatsDiv.style.display = '';
                    statsToggleButton.textContent = 'Hide';
                    areStatsVisible = true;
                }
            }
        });

        infoContainer.appendChild(infoLabel);
        infoContainer.appendChild(latencyLabel);
        infoContainer.appendChild(rateLabel);
        infoContainer.appendChild(statusLabel);

        buttonsContainer.appendChild(toggleButton);
        buttonsContainer.appendChild(statsToggleButton);

        header.appendChild(infoContainer);
        header.appendChild(buttonsContainer);
        container.appendChild(header);

        const canvas = document.createElement('canvas');
        canvas.width = 530;
        canvas.height = 135;
        Object.assign(canvas.style, {
            display: isMaximized ? 'block' : 'none',
            cursor: 'move',
            opacity: isMaximized ? '1' : '0',
            transition: 'opacity 0.2s ease'
        });
        container.appendChild(canvas);
        setTimeout(() => {
            if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
                canvas.style.width = '530px';
                canvas.style.height = '150px';
                canvas.width = 530;
                canvas.height = 180;
            } else {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }
        }, 0);

        const videoWrapper = video?.parentElement?.parentElement;
        if (videoWrapper) {
            videoWrapper.style.position = 'relative';
            container.style.position = 'absolute';
            videoWrapper.appendChild(container);
        } else {
            document.body.appendChild(container);
        }
        latencyGraph = container;

        const ctx = canvas.getContext('2d');
        const data = [];
        const maxPoints = 200;
        const resizeHandleSize = 15;
        const minWidth = 200;
        const minHeight = 50;

        let isDragging = false, isResizing = false, startX = 0, startY = 0, offsetX = 10, offsetY = 10, startWidth = 0, startHeight = 0;

        let lastBufferMemory = 0;

        function toggleDisplay() {
            isMaximized = !isMaximized;
            toggleButton.textContent = isMaximized ? '−' : '+';
            Object.assign(container.style, {
                background: isMaximized ? '#222' : 'rgba(34, 34, 34, 0.5)',
                border: isMaximized ? '1px solid #555' : 'none',
                boxShadow: isMaximized ? '0 2px 10px rgba(0,0,0,0.5)' : 'none',
                minHeight: isMaximized ? '350px' : '70px'
            });
            Object.assign(header.style, {
                background: isMaximized ? '#111' : 'rgba(17, 17, 17, 0.5)',
                borderBottom: isMaximized ? '1px solid #555' : 'none'
            });
            Object.assign(rateLabel.style, { display: isMaximized ? 'block' : 'none', opacity: isMaximized ? '1' : '0' });
            Object.assign(statusLabel.style, { display: isMaximized ? 'block' : 'none', opacity: isMaximized ? '1' : '0' });
            Object.assign(statsToggleButton.style, { display: isMaximized ? 'block' : 'none', opacity: isMaximized ? '1' : '0' });
            Object.assign(canvas.style, { display: isMaximized ? 'block' : 'none', opacity: isMaximized ? '1' : '0' });
            if (controlPanel && controlPanel.parentElement) {
                controlPanel.style.display = isMaximized ? 'flex' : 'none';
                controlPanel.style.opacity = isMaximized ? '1' : '0';
                controlPanel.parentElement.style.display = isMaximized ? 'flex' : 'none';
                controlPanel.parentElement.style.opacity = isMaximized ? '1' : '0';
            }
            if (isMaximized) {
                canvas.width = canvas.clientWidth || 400;
                canvas.height = canvas.clientHeight || 100;
                setTimeout(() => updateGraph(lastBufferMemory), 0);
            }
        }

        toggleButton.addEventListener('click', toggleDisplay);

        container.addEventListener('mousedown', e => {
            if (e.target === toggleButton) return;
            if (isMaximized && e.target === statsToggleButton) return;
            e.preventDefault();
            if (e.target.tagName.toLowerCase() === 'input') return;
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            isDragging = true;
            startX = e.clientX - offsetX;
            startY = e.clientY - offsetY;
            container.style.cursor = 'move';
        });

        document.addEventListener('mousemove', e => {
            if (isDragging) {
                offsetX = e.clientX - startX;
                offsetY = e.clientY - startY;
                container.style.left = `${offsetX}px`;
                container.style.top = `${offsetY}px`;
            } else if (isResizing) {
                const newWidth = clamp(startWidth + (e.clientX - startX), minWidth, 1000);
                const newHeight = clamp(startHeight + (e.clientY - startY), minHeight, 500);
                canvas.style.width = `${newWidth}px`;
                canvas.style.height = `${newHeight}px`;
                canvas.width = newWidth;
                canvas.height = newHeight;
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            isResizing = false;
            container.style.cursor = 'move';
        });

        canvas.addEventListener('mousemove', e => {
            if (canvas.style.display === 'block') {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const isOverResizeHandle = mouseX > canvas.width - resizeHandleSize && mouseY > canvas.height - resizeHandleSize;
                canvas.style.cursor = isOverResizeHandle ? 'se-resize' : 'move';
            }
        });

        canvas.addEventListener('mouseleave', () => {
            canvas.style.cursor = 'default';
        });

        const observer = new ResizeObserver(() => {
            if (!isResizing && isMaximized) {
                canvas.width = canvas.clientWidth || 400;
                canvas.height = canvas.clientHeight || 100;
            }
        });
        observer.observe(canvas);

        return {
            updateGraph: latency => {
                lastBufferMemory = latency;
                data.push(latency);
                if (data.length > maxPoints) data.shift();

                if (canvas.style.display !== 'block') return;

                const maxData = data.length > 0 ? Math.max(...data) : 0;
                const maxValue = Math.max(maxData, config.targetLatency, config.maxBufferThreshold, 1.0);
                const scaleMax = maxValue * 1.2;
                const scaleMin = 0;

                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#222';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                ctx.strokeStyle = '#444';
                ctx.fillStyle = '#888';
                ctx.font = '10px monospace';
                ctx.textAlign = 'right';

                const step = scaleMax / 8;
                for (let latency = 0; latency <= scaleMax; latency += step) {
                    const y = canvas.height - (latency / scaleMax) * canvas.height;
                    if (y >= 0 && y <= canvas.height) {
                        ctx.strokeStyle = '#444';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(30, y);
                        ctx.lineTo(canvas.width, y);
                        ctx.stroke();
                        ctx.fillStyle = '#888';
                        ctx.fillText(latency.toFixed(1) + 's', 28, y + 3);
                    }
                }

                const targetY = canvas.height - (config.targetLatency / scaleMax) * canvas.height;
                if (targetY >= 0 && targetY <= canvas.height) {
                    ctx.strokeStyle = '#0f0';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(30, targetY);
                    ctx.lineTo(canvas.width, targetY);
                    ctx.stroke();
                }

                // Affichage de la zone dead zone en jaune (centrée autour de la target)
                const deadZoneUpperY = canvas.height - ((config.targetLatency + config.deadZone/2) / scaleMax) * canvas.height;
                const deadZoneLowerY = canvas.height - ((config.targetLatency - config.deadZone/2) / scaleMax) * canvas.height;

                if (deadZoneUpperY >= 0 && deadZoneLowerY <= canvas.height) {
                    ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
                    ctx.fillRect(30, deadZoneUpperY, canvas.width - 30, deadZoneLowerY - deadZoneUpperY);

                    // Ligne supérieure de la dead zone
                    ctx.strokeStyle = '#ff0';
                    ctx.lineWidth = 1;
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath();
                    ctx.moveTo(30, deadZoneUpperY);
                    ctx.lineTo(canvas.width, deadZoneUpperY);
                    ctx.stroke();

                    // Ligne inférieure de la dead zone
                    ctx.beginPath();
                    ctx.moveTo(30, deadZoneLowerY);
                    ctx.lineTo(canvas.width, deadZoneLowerY);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    ctx.fillStyle = '#ff0';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'left';
                    ctx.fillText('DZ', 35, (deadZoneUpperY + deadZoneLowerY) / 2 + 3);
                    ctx.textAlign = 'right';
                }

                const maxThresholdY = canvas.height - (config.maxBufferThreshold / scaleMax) * canvas.height;
                if (maxThresholdY >= 0 && maxThresholdY <= canvas.height) {
                    ctx.strokeStyle = '#f00';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(30, maxThresholdY);
                    ctx.lineTo(canvas.width, maxThresholdY);
                    ctx.stroke();

                    ctx.fillStyle = '#f00';
                    ctx.font = '10px monospace';
                    ctx.textAlign = 'left';
                    ctx.fillText('MAX', 35, maxThresholdY - 2);
                    ctx.textAlign = 'right';
                }

                ctx.strokeStyle = '#0af';
                ctx.lineWidth = 2;
                ctx.beginPath();

                data.forEach((val, idx) => {
                    const x = 30 + ((idx / maxPoints) * (canvas.width - 30));
                    const y = canvas.height - (val / scaleMax) * canvas.height;
                    if (idx === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                });

                ctx.stroke();
                ctx.lineWidth = 1;
            },
            container,
            rateLabel,
            canvas,
            infoLabel,
            latencyLabel,
            statusLabel,
            toggleButton
        };
    }

    function createControlPanel(container, canvas, toggleButton) {
        const controlsContainer = document.createElement('div');
        Object.assign(controlsContainer.style, {
            display: isMaximized ? 'flex' : 'none',
            flexDirection: 'column',
            gap: '10px',
            opacity: isMaximized ? '1' : '0',
            transition: 'opacity 0.2s ease',
            padding: '8px 12px'
        });

        // Stockage des références des inputs pour pouvoir les mettre à jour
        const inputRefs = {};

        function createInput(label, value, step, key) {
            const container = document.createElement('div');
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.gap = '5px';

            const labelEl = document.createElement('span');
            labelEl.textContent = label;
            labelEl.style.color = '#fff';

            const input = document.createElement('input');
            input.type = 'number';
            input.value = value;
            input.step = step;
            input.style.width = '80px';
            input.style.padding = '4px';
            input.style.background = '#333';
            input.style.color = '#fff';
            input.style.border = '1px solid #555';
            input.style.borderRadius = '3px';

            // Stocker la référence de l'input
            inputRefs[key] = input;

            input.addEventListener('mousedown', e => e.stopPropagation());
            input.addEventListener('change', () => {
                config[key] = parseFloat(input.value);
                console.log (`saveConfig(${currentMode})`);
                saveConfig(currentMode);
            });

            container.appendChild(labelEl);
            container.appendChild(input);
            return container;
        }

        // Fonction pour mettre à jour tous les inputs avec les nouvelles valeurs de config
        updateControlInputs = function() {
            console.log('Mise à jour des inputs du panneau de contrôle avec la nouvelle config');
            Object.keys(inputRefs).forEach(key => {
                if (config[key] !== undefined) {
                    inputRefs[key].value = config[key];
                }
            });
        };

        const row1 = document.createElement('div');
        row1.style.display = 'flex';
        row1.style.gap = '15px';
        row1.appendChild(createInput('Target:', config.targetLatency, 0.1, 'targetLatency'));
        row1.appendChild(createInput('Max Buffer:', config.maxBufferThreshold, 0.1, 'maxBufferThreshold'));
        row1.appendChild(createInput('Dead Zone:', config.deadZone, 0.1, 'deadZone'));

        controlsContainer.appendChild(row1);

        const controlsRow = document.createElement('div');
        Object.assign(controlsRow.style, {
            padding: '8px 12px',
            background: isMaximized ? '#111' : 'rgba(17, 17, 17, 0.5)',
            borderBottom: isMaximized ? '1px solid #555' : 'none',
            display: isMaximized ? 'flex' : 'none',
            flexDirection: 'column',
            gap: '10px',
            opacity: isMaximized ? '1' : '0',
            transition: 'opacity 0.2s ease'
        });

        controlsRow.appendChild(controlsContainer);
        container.insertBefore(controlsRow, container.querySelector('canvas'));
        controlPanel = controlsContainer;

        toggleButton.addEventListener('click', () => {
            controlsRow.style.display = isMaximized ? 'flex' : 'none';
            controlsRow.style.opacity = isMaximized ? '1' : '0';
            controlsContainer.style.display = isMaximized ? 'flex' : 'none';
            controlsContainer.style.opacity = isMaximized ? '1' : '0';
        });
    }

    cleanup();
    waitForVideo();

})();
