// ==UserScript==
// @name        LavenderDragonDesign Enhancer
// @namespace   http://tampermonkey.net/
// @version     24.12 // CRITICAL FIX: Fixed Profit calc.
// @description The definitive, stable version. Powerful keyword tool with Etsy trends and a high-performance image editor.
// @match       https://mydesigns.io/app/*
// @grant       GM_addStyle
// @grant       GM_xmlhttpRequest
// @connect     google.com
// @connect     generativelanguage.googleapis.com
// @connect     completion.amazon.com
// @connect     redbubble.com
// @connect     allorigins.win
// ==/UserScript==

(function () {
    'use strict';

    // --- GLOBALS ---
    let describerImageFile = null;
    let initialModalText = '';
    let activePopout = { type: null, hasChanges: false };

    // --- Editor Globals ---
    let editorCanvas, editorCtx, originalImageData, currentImage;
    let editorWorker;
    let debounceTimer;
    let editorPanZoom = { zoom: 1, panX: 0, panY: 0, isPanning: false, lastX: 0, lastY: 0 };

    // --- Eraser Globals ---
    let eraserCanvas, eraserCtx, eraserOriginalImage, isErasing = false, eraserBrushSize = 30;
    let eraserPanZoom = { zoom: 1, panX: 0, panY: 0, isPanning: false, lastX: 0, lastY: 0 };


    // Define core function variables in a shared scope
    let calculateProfit, calculateSuggestedSalePrice, findRankedKeywords, syncToStorage, loadFromStorage, makeDraggable, makeResizable, createKeywordRow, describeImage;
    let handleImageUpload, resetEditor, downloadEditorImage, postToWorker;
    let handleEraserUpload, resetEraser, downloadEraserImage;


    // --- WEB WORKER CODE ---
    const workerScript = `
        let originalImageData = null;
        const clamp = (val, min, max) => Math.max(min, Math.min(val, max));
        function rgbToHsl(r, g, b) { r /= 255, g /= 255, b /= 255; let max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2; if (max == min) { h = s = 0; } else { let d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; } h /= 6; } return [h, s, l]; }
        function hslToRgb(h, s, l) { let r, g, b; if (s == 0) { r = g = b = l; } else { const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q - p) * 6 * t; if (t < 1/2) return q; if (t < 2/3) return p + (q - p) * (2/3 - t) * 6; return p; }; let q = l < 0.5 ? l * (1 + s) : l + s - l * s; let p = 2 * l - q; r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3); } return [r * 255, g * 255, b * 255]; }
        function applyImageFilters(adjustments) {
            if (!originalImageData) return;
            const data = new Uint8ClampedArray(originalImageData.data);
            const { brightness, contrast, exposure, vibrance, saturation, hue, temperature, tint, invert, grayscale } = adjustments;
            const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
            const exposureFactor = Math.pow(2, exposure / 100);
            for (let i = 0; i < data.length; i += 4) {
                let r = data[i], g = data[i + 1], b = data[i + 2];
                if (exposure !== 0) { r *= exposureFactor; g *= exposureFactor; b *= exposureFactor; }
                if (temperature !== 0) { r += temperature * 1.5; b -= temperature * 1.5; }
                if (tint !== 0) { g += tint; r -= tint / 2; b -= tint / 2; }
                if (brightness !== 0) { r += brightness; g += brightness; b += brightness; }
                if (contrast !== 0) { r = contrastFactor * (r - 128) + 128; g = contrastFactor * (g - 128) + 128; b = contrastFactor * (b - 128) + 128; }
                r = clamp(r, 0, 255); g = clamp(g, 0, 255); b = clamp(b, 0, 255);
                let hsl = rgbToHsl(r, g, b);
                let h = hsl[0], s = hsl[1], l = hsl[2];
                if (vibrance !== 0) { const max = Math.max(r, g, b); const avg = (r + g + b) / 3; const amt = (Math.abs(max - avg) * 2 / 255) * (vibrance / 100); s += amt; }
                if (saturation !== 0) { s += (saturation / 100); }
                if (grayscale > 0) { s = s * (1 - (grayscale / 100)); }
                s = clamp(s, 0, 1);
                if (hue !== 0) { h += hue / 360; if (h > 1) h -= 1; if (h < 0) h += 1; }
                let newRgb = hslToRgb(h, s, l);
                r = newRgb[0]; g = newRgb[1]; b = newRgb[2];
                if (invert > 0) { const invertAmount = invert / 100; r = r * (1 - invertAmount) + (255 - r) * invertAmount; g = g * (1 - invertAmount) + (255 - g) * invertAmount; b = b * (1 - invertAmount) + (255 - b) * invertAmount; }
                data[i] = r; data[i + 1] = g; data[i + 2] = b;
            }
            return new ImageData(data, originalImageData.width, originalImageData.height);
        }
        self.onmessage = function(e) { const { type, payload } = e.data; if (type === 'init') { originalImageData = payload.imageData; } else if (type === 'apply') { const newImageData = applyImageFilters(payload.adjustments); if (newImageData) { self.postMessage({ type: 'result', newImageData: newImageData }, [newImageData.data.buffer]); } } };
    `;
    const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);


    // --- INITIALIZATION ---
    setInterval(() => { if (document.body && document.body.children.length > 1 && !document.getElementById('md-enhancer')) { initializeWidget(); } }, 500);

    function initializeWidget() {
        if (document.getElementById('md-enhancer')) return;
        const logoURL = "https://i.postimg.cc/y6M6KPZ5/logo.jpg";
        const closeIconURL = "https://i.postimg.cc/3rcbPYPg/x-icon.png";
        const bmcImageURL = "https://i.postimg.cc/28YhHbfZ/bmc-button.png";
        const bmcLinkURL = "https://buymeacoffee.com/lavenderdragondesigns";
        const etsyLinkURL = "https://www.etsy.com/shop/LavenderDragonDesign";
        const wrapper = document.createElement('div');
        wrapper.id = 'md-enhancer'; wrapper.classList.add('hidden');
        wrapper.innerHTML = `
            <img id="md-close" src="${closeIconURL}" alt="Close" title="Close" />
            <div class="enhancer-header" id="md-drag-handle"><div class="header-title">🧠 LavenderDragonDesign's Enhancer v.24</div></div>
            <div class="tab-header">
                <div class="tab" data-tab="vision">Custom Instructions</div>
                <div class="tab" data-tab="editor">Image Editor</div>
                <div class="tab" data-tab="erase">Erase Tool</div>
                <div class="tab" data-tab="niche">Keywords</div>
                <div class="tab" data-tab="describer">Image Describer</div>
                <div class="tab" data-tab="profit">Profit Calc</div>
                <div class="tab" data-tab="settings">Settings</div>
            </div>
            <div class="tab-content" id="vision-tab" style="display:none;"></div>
            <div class="tab-content" id="editor-tab" style="display:none;"></div>
            <div class="tab-content" id="erase-tab" style="display:none;"></div>
            <div class="tab-content" id="niche-tab" style="display:none;"></div>
            <div class="tab-content" id="describer-tab" style="display:none;"></div>
            <div class="tab-content" id="profit-tab" style="display:none;"></div>
            <div class="tab-content" id="settings-tab" style="display:none;"></div>
            <div class="enhancer-footer">
                <small>Powered by LavenderDragonDesign</small>
                <a href="${etsyLinkURL}" target="_blank" rel="noopener noreferrer" class="footer-link">My Etsy Shop</a>
                <a href="${bmcLinkURL}" target="_blank" rel="noopener noreferrer"><img src="${bmcImageURL}" alt="Buy Me a Coffee" class="bmc-button"></a>
            </div>
            <div id="md-resize-handle"></div>`;

        const editorPopoutHTML = `
            <div id="md-editor-popout" class="md-popout-window" style="display: none;">
                <img id="md-editor-popout-close" src="${closeIconURL}" alt="Close" title="Close Editor" class="popout-close-btn"/>
                <div class="enhancer-header" id="md-editor-popout-drag-handle">Image Editor</div>
                <div class="popout-main-content">
                    <div class="popout-controls-panel">
                         <h3 class="niche-h3">Image Adjustments</h3>
                         <p class="md-hint">Upload a PNG or JPG to begin.</p>
                         <label for="editor-file-input" class="file-input-label">Choose an Image</label>
                         <input type="file" id="editor-file-input" accept="image/png, image/jpeg" style="display:none;">
                         <div id="editor-main-content" style="display:none;">
                            <h4 class="editor-group-header">Tonal Adjustments</h4><label for="editor-brightness-slider">Brightness: <span id="editor-brightness-value">0</span></label><input type="range" id="editor-brightness-slider" min="-100" max="100" value="0"><label for="editor-contrast-slider">Contrast: <span id="editor-contrast-value">0</span></label><input type="range" id="editor-contrast-slider" min="-100" max="100" value="0"><label for="editor-exposure-slider">Exposure: <span id="editor-exposure-value">0</span></label><input type="range" id="editor-exposure-slider" min="-100" max="100" value="0"><h4 class="editor-group-header">Color Adjustments</h4><label for="editor-vibrance-slider">Vibrance: <span id="editor-vibrance-value">0</span></label><input type="range" id="editor-vibrance-slider" min="-100" max="100" value="0"><label for="editor-saturation-slider">Saturation: <span id="editor-saturation-value">0</span></label><input type="range" id="editor-saturation-slider" min="-100" max="100" value="0"><label for="editor-hue-slider">Hue Shift: <span id="editor-hue-value">0</span>°</label><input type="range" id="editor-hue-slider" min="-180" max="180" value="0"><label for="editor-temperature-slider">Temperature: <span id="editor-temperature-value">0</span></label><input type="range" id="editor-temperature-slider" min="-100" max="100" value="0"><label for="editor-tint-slider">Tint: <span id="editor-tint-value">0</span></label><input type="range" id="editor-tint-slider" min="-100" max="100" value="0"><h4 class="editor-group-header">Creative Effects</h4><label for="editor-grayscale-slider">Grayscale: <span id="editor-grayscale-value">0</span>%</label><input type="range" id="editor-grayscale-slider" min="0" max="100" value="0"><label for="editor-invert-slider">Invert: <span id="editor-invert-value">0</span>%</label><input type="range" id="editor-invert-slider" min="0" max="100" value="0">
                             <div class="editor-buttons-row">
                                <button id="editor-reset-btn">Reset Adjustments</button>
                                <button id="editor-download-btn">Download Image</button>
                             </div>
                             <div id="editor-status" class="md-hint" style="height: 14px; color: #6c757d; margin-top: 10px;"></div>
                         </div>
                    </div>
                    <div class="popout-canvas-container" id="editor-canvas-container">
                        <canvas id="editor-canvas"></canvas>
                        <div id="editor-placeholder-text" class="canvas-placeholder-text">Please upload an image to begin adjusting.</div>
                        <div class="canvas-hint">Middle Mouse to Pan | Scroll to Zoom</div>
                    </div>
                </div>
                <div id="md-editor-popout-resize-handle" class="popout-resize-handle"></div>
            </div>`;

        const eraserPopoutHTML = `
            <div id="md-eraser-popout" class="md-popout-window" style="display: none;">
                <img id="md-eraser-popout-close" src="${closeIconURL}" alt="Close" title="Close Eraser" class="popout-close-btn"/>
                <div class="enhancer-header" id="md-eraser-popout-drag-handle">Erase Tool</div>
                 <div class="popout-main-content">
                    <div class="popout-controls-panel">
                        <h3 class="niche-h3">Erase Tool (BETA)</h3>
                        <p class="md-hint">Upload an image, then click and drag to erase.</p>
                        <label for="eraser-file-input" class="file-input-label">Choose an Image</label>
                        <input type="file" id="eraser-file-input" accept="image/png, image/jpeg" style="display:none;">
                        <div id="eraser-main-content" style="display:none;">
                             <h4 class="editor-group-header">Eraser Settings</h4>
                             <label for="eraser-brush-size-slider">Brush Size: <span id="eraser-brush-size-value">30</span>px</label>
                             <input type="range" id="eraser-brush-size-slider" min="1" max="200" value="30">
                             <div class="editor-buttons-row">
                                <button id="eraser-reset-btn">Reset Image</button>
                                <button id="eraser-download-btn">Download Erased PNG</button>
                            </div>
                        </div>
                    </div>
                    <div class="popout-canvas-container" id="eraser-canvas-container">
                        <canvas id="eraser-canvas"></canvas>
                        <div id="eraser-placeholder-text" class="canvas-placeholder-text">Please upload an image to begin erasing.</div>
                         <div class="canvas-hint">Middle Mouse to Pan | Scroll to Zoom</div>
                    </div>
                </div>
                <div id="md-eraser-popout-resize-handle" class="popout-resize-handle"></div>
            </div>`;


        const managerModalHTML = `<div id="md-manager-modal-backdrop" style="display:none;"><div id="md-custom-instructions-modal"><img id="md-manager-modal-close-btn" src="${closeIconURL}" alt="Close" /><h3>Custom Instructions Manager</h3><div class="modal-controls-row"><select id="md-modal-instructions-select"></select><button id="md-modal-add-btn" class="modal-manage-btn" title="Add New Instruction">New</button><button id="md-modal-save-btn" class="modal-manage-btn" title="Save Changes to Selected">Save</button><button id="md-modal-delete-btn" class="modal-manage-btn" title="Delete Selected Instruction">Delete</button></div><textarea id="md-modal-instructions-textarea" rows="8" placeholder="Select an instruction to edit, or create a new one."></textarea><p class="md-hint" style="font-size:12px; margin: 5px 0;">💡 Tip: Make sure the Custom Instructions box is open in before pasting.</p><div class="modal-button-row"><button id="md-modal-copy-btn">Copy to Clipboard</button><button id="md-modal-paste-btn">Paste to Vision AI & Close</button></div></div></div>`;
        const genericModalHTML = `<div id="md-generic-modal-backdrop" style="display:none;"><div id="md-generic-modal"><h3 id="md-generic-modal-title"></h3><p id="md-generic-modal-message"></p><div id="md-generic-modal-input-wrapper" style="display:none;"><label id="md-generic-modal-input-label"></label><input type="text" id="md-generic-modal-input"></div><div class="modal-button-row"><button id="md-generic-modal-cancel-btn" class="modal-secondary-btn">Cancel</button><button id="md-generic-modal-ok-btn">OK</button></div></div></div>`;
        document.body.appendChild(wrapper);
        document.body.insertAdjacentHTML('beforeend', editorPopoutHTML);
        document.body.insertAdjacentHTML('beforeend', eraserPopoutHTML);
        document.body.insertAdjacentHTML('beforeend', managerModalHTML);
        document.body.insertAdjacentHTML('beforeend', genericModalHTML);
        injectTabHTML(wrapper);
        if (!document.getElementById('md-toggle-wrapper')) {
            const toggleWrapper = document.createElement('div');
            toggleWrapper.id = 'md-toggle-wrapper'; toggleWrapper.innerHTML = `<img id="md-toggle-icon" src="${logoURL}" alt="Open Enhancer" />`;
            document.body.appendChild(toggleWrapper);
        }
        addEventListeners();
        loadFromStorage();
        const savedWidth = localStorage.getItem('md-enhancer-width'); if (savedWidth) wrapper.style.width = savedWidth;
        const savedHeight = localStorage.getItem('md-enhancer-height'); if (savedHeight) wrapper.style.height = savedHeight;
        makeDraggable(wrapper, document.getElementById('md-drag-handle'));
        makeResizable(wrapper, document.getElementById('md-resize-handle'));
        makeDraggable(document.getElementById('md-editor-popout'), document.getElementById('md-editor-popout-drag-handle'));
        makeResizable(document.getElementById('md-editor-popout'), document.getElementById('md-editor-popout-resize-handle'));
        makeDraggable(document.getElementById('md-eraser-popout'), document.getElementById('md-eraser-popout-drag-handle'));
        makeResizable(document.getElementById('md-eraser-popout'), document.getElementById('md-eraser-popout-resize-handle'));
    }

    function injectTabHTML(mainWrapper) {
        const popoutLauncherHTML = (toolName, popoutFn) => `<div class="popout-launcher-content"><h3>${toolName}</h3><p class="md-hint" style="margin-top:20px;">The ${toolName} opens in a new, resizable window for a better workflow.</p><button id="open-${popoutFn}-popout-btn" class="popout-launcher-btn">Open ${toolName}</button></div>`;
        const editorTabHTML = popoutLauncherHTML("Image Editor", "editor");
        const eraseTabHTML = popoutLauncherHTML("Erase Tool", "eraser");
        const describerTabHTML = `<h3 class="niche-h3">AI Image Describer</h3><small class="md-hint">Generates SEO-friendly tags & a description from an image.</small><small class="md-hint">Requires a Gemini API Key in the Settings tab.</small><label for="describer-file-input" class="file-input-label">Choose an Image (PNG or JPG)</label><input type="file" id="describer-file-input" accept="image/png, image/jpeg" style="display:none;"><div id="describer-file-status">No file selected.</div><div id="describer-controls" style="display:none;"><button id="describer-generate-btn">Describe Image</button><div id="describer-status"></div><div id="describer-results-wrapper" style="display:none;"><label for="describer-tags-result">Generated Tags:</label><textarea id="describer-tags-result" rows="3" readonly></textarea><button id="describer-copy-tags-btn">Copy Tags</button><label for="describer-desc-result">Generated Description:</label><textarea id="describer-desc-result" rows="5" readonly></textarea><button id="describer-copy-desc-btn">Copy Description</button></div></div>`;
        const settingsTabHTML = `<div class="profit-section"><h3>Gemini API Key</h3><p class="md-hint" style="white-space: normal; text-align: left;">Your Gemini API key is needed for the "Image Describer" AI tool. It is stored only in your browser.</p><label for="settings-api-key">Your Gemini API Key:</label><input type="password" id="settings-api-key" placeholder="Paste your Gemini key here"><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" class="settings-link">Get a free Gemini Key</a><button id="settings-save-gemini-btn">Save Gemini Key</button><div id="settings-gemini-status" class="api-status"></div></div><hr><div class="profit-section"><h3>Disclaimer</h3><p class="md-hint" style="white-space: normal; text-align: left; font-size:12px;">This tool is provided 'as-is'. The developer is not liable for any damages. You are responsible for any costs incurred from your own API key usage.</p></div>`;
        const visionTabHTML = `<h3 class="niche-h3" style="margin-bottom:5px;">Custom Instructions Generator</h3><small class="md-hint">Generate Preset Prompts for Vision AI Custom Instructions Box. 💡 Tip: Make sure the Custom Instructions box is open in before pasting</small><label>Enter Main Keyword:</label><input type="text" id="md-main-word" placeholder="e.g. Halloween, Retro Floral" /><label>Product Type:</label><select id="md-product-type"><option value="PNG">PNG</option><option value="SVG">SVG</option><option value="Tumbler Wrap">Tumbler Wrap</option><option value="Mug Wrap">Mug Wrap</option></select><label>Custom Type (optional):</label><input type="text" id="md-custom-type" placeholder="e.g. Wall Art" /><button id="md-generate">Generate</button><button id="md-copy">Copy Generated</button><label>Output:</label><textarea id="md-result" rows="3" readonly></textarea><button id="md-paste">Paste Generated to Vision AI</button><hr class="section-divider"><h3 class="niche-h3" style="margin-bottom:5px;">Your Custom Instructions</h3><small class="md-hint" style="margin-bottom: 8px;">💡 Tip: Make sure the Custom Instructions box is open in before opening</small><button id="md-manage-instructions-btn">Open Saved Custom Instructions Manager</button>`;
        const profitTabHTML = `<small class="md-hint">Enter your data and click the button to calculate all results. These are all estimated. They may not be perfectly accurate.</small><div class="profit-section"><h3>Your Sales</h3><div class="pc-input-row"><label for="pc-sale-price">Sale Price ($):</label><input type="number" id="pc-sale-price" value="10.00" min="0" step="0.01" /></div><div class="pc-input-row"><label for="pc-shipping-price-customer">Shipping Charged ($):</label><input type="number" id="pc-shipping-price-customer" value="0.00" min="0" step="0.01" /></div><div class="pc-input-row"><label for="pc-item-quantity">Item Quantity:</label><input type="number" id="pc-item-quantity" value="1" min="1" step="1" /></div><label>Discount:</label><div class="pc-cost-toggle"><input type="number" id="pc-discount-value" value="0.00" min="0" step="0.01" /><select id="pc-discount-type"><option value="flat">$</option><option value="percent">%</option></select></div></div><div class="profit-section"><h3>Your Costs</h3><div class="pc-input-row"><label for="pc-cost-per-item">Cost per Item ($):</label><input type="number" id="pc-cost-per-item" value="5.00" min="0" step="0.01" /></div><div class="pc-input-row"><label for="pc-actual-shipping-cost">Actual Shipping Cost ($):</label><input type="number" id="pc-actual-shipping-cost" value="0.00" min="0" step="0.01" /></div><div class="pc-input-row"><label for="pc-listing-fee">Etsy Listing Fee ($):</label><input type="number" id="pc-listing-fee" value="0.20" min="0" step="0.01" /></div><label>Payment Processing Fee:</label><span class="md-hint" style="margin-top: -4px;">3% + $0.25</span><div class="pc-input-row"><label for="pc-transaction-fee-percent">Etsy Transaction Fee (%):</label><input type="number" id="pc-transaction-fee-percent" value="6.5" min="0" step="0.1" /></div><label>Advertising Cost:</label><div class="pc-cost-toggle"><input type="number" id="pc-advertising-cost" value="0.00" min="0" step="0.01" /><select id="pc-advertising-type"><option value="percent">%</option><option value="flat">$</option></select></div><label>Misc. Costs:</label><div class="pc-cost-toggle"><input type="number" id="pc-misc-cost" value="0.00" min="0" step="0.01" /><select id="pc-misc-type"><option value="percent">%</option><option value="flat">$</option></select></div></div><div class="profit-section"><h3>Results & Goal</h3><div class="pc-input-row"><label for="pc-goal-value">Goal Net Profit ($):</label><input type="number" id="pc-goal-value" value="5.00" min="0" step="0.01" /></div><button id="pc-calculate-btn">Calculate Results & Suggested Price</button><p class="pc-result-line"><strong>Suggested Sale Price:</strong> <span id="pc-suggested-sale-price">$0.00</span></p><hr><p class="pc-result-line"><strong>Proceeds:</strong> <span id="pc-proceeds">$0.00</span></p><p class="pc-result-line"><strong>Total Costs:</strong> <span id="pc-total-costs">$0.00</span></p><p class="pc-result-line"><strong>Net Profit:</strong> <span id="pc-net-profit">$0.00</span></p><p class="pc-result-line"><strong>Return:</strong> <span id="pc-return">0.00%</span></p><p class="pc-result-line"><strong>Margin:</strong> <span id="pc-margin">0.00%</span></p></div>`;
        const nicheTabHTML = `<h3 class="niche-h3">POD Keyword & Trend Finder</h3><small class="md-hint">Finds Etsy trends, product-specific keywords, and long-tail ideas.</small><label for="niche-keyword">Main Design Subject:</label><input type="text" id="niche-keyword" placeholder="e.g., watercolor cat, retro floral" /><button id="niche-generate-keywords">Generate Listing Keywords</button><div id="niche-status" style="margin-top: 10px; text-align: center;"></div><div id="niche-results-container"></div>`;
        mainWrapper.querySelector('#editor-tab').innerHTML = editorTabHTML;
        mainWrapper.querySelector('#erase-tab').innerHTML = eraseTabHTML;
        mainWrapper.querySelector('#describer-tab').innerHTML = describerTabHTML;
        mainWrapper.querySelector('#vision-tab').innerHTML = visionTabHTML;
        mainWrapper.querySelector('#profit-tab').innerHTML = profitTabHTML;
        mainWrapper.querySelector('#niche-tab').innerHTML = nicheTabHTML;
        mainWrapper.querySelector('#settings-tab').innerHTML = settingsTabHTML;

        // Inject Resize Tab
        const resizeTabHTML = `
          <h3 class="niche-h3">Image Resizer</h3>
          <small class="md-hint">Resize your PNG or JPG images. DPI metadata will be applied to PNGs if enabled.</small>
          <label for="resize-file-input" class="file-input-label">Choose an Image</label>
          <input type="file" id="resize-file-input" accept="image/png, image/jpeg" style="display:none;">
          <div id="resize-file-status">No file selected.</div>
          <label for="resize-width">Width (px):</label>
          <input type="number" id="resize-width" value="3000" min="1" />
          <label for="resize-height">Height (px):</label>
          <input type="number" id="resize-height" value="3000" min="1" />
          <label for="resize-dpi-slider">Force 300 DPI: <span id="resize-dpi-value">Yes</span></label>
          <input type="range" id="resize-dpi-slider" min="0" max="1" value="1" />
          <button id="resize-download-btn">Download Resized Image</button>
        `;

        mainWrapper.querySelector('.tab-header').insertAdjacentHTML('beforeend', `<div class="tab" data-tab="resize">Resize</div>`);
        const resizeDiv = document.createElement('div');
        resizeDiv.id = 'resize-tab';
        resizeDiv.className = 'tab-content';
        resizeDiv.style.display = 'none';
        resizeDiv.innerHTML = resizeTabHTML;
        mainWrapper.insertBefore(resizeDiv, mainWrapper.querySelector('.enhancer-footer'));
    }

    // --- EVENT LISTENERS ---
    function addEventListeners() {
        let resizeImageData = null;

        // Main UI, Popout, and Modal Click Handler (Event Delegation)
        document.body.addEventListener('click', function(e) {
            const targetEl = e.target;
            const targetId = targetEl.id;

            // Main UI Toggle & Close
            if (targetEl.closest('#md-toggle-wrapper')) { document.getElementById('md-enhancer')?.classList.toggle('visible'); document.getElementById('md-enhancer')?.classList.toggle('hidden'); return; }
            if (targetId === 'md-close') { document.getElementById('md-enhancer')?.classList.add('hidden'); return; }

            // Popout Open/Close
            if (targetId === 'open-editor-popout-btn') { openPopout('editor'); return; }
            if (targetId === 'open-eraser-popout-btn') { openPopout('eraser'); return; }

            if (targetEl.classList.contains('popout-close-btn')) {
                const popout = targetEl.closest('.md-popout-window');
                if (popout.id === 'md-editor-popout') {
                    handlePopoutClose('editor', () => { popout.style.display = 'none'; });
                } else if (popout.id === 'md-eraser-popout') {
                    handlePopoutClose('eraser', () => { popout.style.display = 'none'; });
                }
                return;
            }

            // Tab Switching
            if (targetEl.classList.contains('tab')) {
                const newTab = targetEl.dataset.tab;
                const currentTab = document.querySelector('.tab.active')?.dataset.tab;
                if (newTab === currentTab) return;

                const performSwitch = () => {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
                    targetEl.classList.add('active'); const contentTab = document.getElementById(`${newTab}-tab`); if(contentTab) contentTab.style.display = 'block';
                };
                if (activePopout.hasChanges) {
                    e.preventDefault();
                    e.stopPropagation();
                    handlePopoutClose(activePopout.type, performSwitch);
                } else {
                    performSwitch();
                }
                return;
            }

            // Popout Editor Tools
            if (targetId === 'editor-reset-btn') { resetEditor(); return; }
            if (targetId === 'editor-download-btn') { downloadEditorImage(); return; }

            // Popout Eraser Tools
            if (targetId === 'eraser-reset-btn') { resetEraser(); return; }
            if (targetId === 'eraser-download-btn') { downloadEraserImage(); return; }


            // Main UI Features
            const enhancer = document.getElementById('md-enhancer');
            if (enhancer && enhancer.contains(targetEl)) {
                switch (targetId) {
                    case 'md-generate':
                        const mainKeyword = document.getElementById('md-main-word').value.trim();
                        if (!mainKeyword) { showCustomModal({ title: 'Input Required', message: 'Please enter a main keyword.', type: 'alert' }); return; }
                        const type = document.getElementById('md-custom-type').value.trim() || document.getElementById('md-product-type').value;
                        const generatedContent = `This is a ${mainKeyword} ${type}, Use ${mainKeyword} and ${mainKeyword} ${type} in the title and tags and use ${type} no more than 3 times. Use relevant keywords.`;
                        document.getElementById('md-result').value = generatedContent;
                        syncToStorage();
                        showCustomModal({ title: 'Save Prompt?', message: 'Save this to your Custom Instructions Manager?', type: 'confirm', onOk: () => { showCustomModal({ title: 'Save New Prompt', label: 'Prompt Name:', type: 'prompt', defaultValue: mainKeyword, onOk: (name) => { if (name && saveNewInstruction(name, generatedContent)) { copyToClipboard(null, document.getElementById('md-generate'), "Generate", "✅ Saved!"); } } }); } });
                        break;
                    case 'md-copy':
                        copyToClipboard(document.getElementById('md-result').value, targetEl, 'Copy Generated');
                        break;
                    case 'md-paste':
                        const ta = document.querySelector('textarea[placeholder*="emojis"]');
                        if (ta) { ta.value = document.getElementById('md-result').value; ta.dispatchEvent(new Event('input', { bubbles: true })); }
                        break;
                    case 'pc-calculate-btn': runAllCalculations(); break;
                    case 'niche-generate-keywords': findRankedKeywords(); break;
                    case 'describer-generate-btn': describeImage(); break;
                    case 'describer-copy-tags-btn': copyToClipboard(document.getElementById('describer-tags-result').value, targetEl, 'Copy Tags'); break;
                    case 'describer-copy-desc-btn': copyToClipboard(document.getElementById('describer-desc-result').value, targetEl, 'Copy Description'); break;
                    case 'settings-save-gemini-btn': saveGeminiApiKey(); break;
                    case 'md-manage-instructions-btn': openInstructionsModal(); break;
                    case 'resize-download-btn':
                        if (!resizeImageData) return;
                        const w = parseInt(document.getElementById('resize-width').value);
                        const h = parseInt(document.getElementById('resize-height').value);
                        const dpiToggle = document.getElementById('resize-dpi-slider').value === '1';

                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(resizeImageData, 0, 0, w, h);

                        canvas.toBlob(async blob => {
                            const buffer = await blob.arrayBuffer();
                            const uint8 = new Uint8Array(buffer);
                            if (dpiToggle && blob.type === 'image/png') {
                                const dpiChunk = create300DPIChunk(300);
                                const final = insertDPIIntoPNG(uint8, dpiChunk);
                                const a = document.createElement('a');
                                a.download = 'resized-300dpi.png';
                                a.href = URL.createObjectURL(new Blob([final], { type: 'image/png' }));
                                a.click();
                            } else {
                                const a = document.createElement('a');
                                a.download = 'resized-image.png';
                                a.href = URL.createObjectURL(blob);
                                a.click();
                            }
                        }, 'image/png');
                        break;
                }
                if (targetEl.classList.contains('niche-copy-btn')) { copyToClipboard(targetEl.dataset.keyword, targetEl, 'Copy'); }
            }

            // Modal Handlers
            if (targetEl.closest('#md-custom-instructions-modal')) {
                switch (targetId) {
                    case 'md-manager-modal-close-btn': closeInstructionsModal(); break;
                    case 'md-modal-paste-btn': pasteAndCloseModal(); break;
                    case 'md-modal-copy-btn': copyToClipboard(document.getElementById('md-modal-instructions-textarea').value, targetEl, 'Copy to Clipboard'); break;
                    case 'md-modal-add-btn': addNewInstruction(); break;
                    case 'md-modal-save-btn': saveSelectedInstruction(targetEl); break;
                    case 'md-modal-delete-btn': deleteSelectedInstruction(); break;
                }
            }
        });

        // File/Input Change Handlers
        document.body.addEventListener('change', function(e) {
             const target = e.target;
             const targetId = target.id;
             if (targetId === 'describer-file-input') handleFileSelection(e);
             else if (targetId === 'editor-file-input') handleImageUpload(e);
             else if (targetId === 'eraser-file-input') handleEraserUpload(e);
             else if (targetId === 'md-modal-instructions-select') loadSelectedInstruction();
             else if (targetId === 'resize-file-input') {
                 const file = e.target.files[0];
                 if (!file) return;
                 const reader = new FileReader();
                 reader.onload = function (event) {
                     const img = new Image();
                     img.onload = function () {
                         resizeImageData = img;
                         document.getElementById('resize-file-status').textContent = file.name;
                         document.getElementById('resize-width').value = img.width;
                         document.getElementById('resize-height').value = img.height;
                     };
                     img.src = event.target.result;
                 };
                 reader.readAsDataURL(file);
             }
             else syncToStorage();
        });
        document.body.addEventListener('input', function(e) {
            const target = e.target;
            if (target.id.startsWith('editor-') && target.id.endsWith('-slider')) {
                const valueSpanId = target.id.replace('-slider', '-value');
                const valueSpan = document.getElementById(valueSpanId);
                if (valueSpan) {
                    valueSpan.textContent = target.value;
                }
                postToWorker();
                activePopout.hasChanges = true;
            }
            if (target.id === 'eraser-brush-size-slider') {
                eraserBrushSize = parseInt(target.value, 10);
                document.getElementById('eraser-brush-size-value').textContent = target.value;
            }
            if (target.id === 'resize-dpi-slider') {
                 const isEnabled = target.value === '1';
                 document.getElementById('resize-dpi-value').textContent = isEnabled ? 'Yes' : 'No';
                 target.style.backgroundColor = isEnabled ? '#28a745' : '#cccccc';
            }
            syncToStorage();
        });

        // Set initial state for DPI toggle
        const dpiSlider = document.getElementById('resize-dpi-slider');
        if(dpiSlider) {
            const isEnabled = dpiSlider.value === '1';
            dpiSlider.style.backgroundColor = isEnabled ? '#28a745' : '#cccccc';
        }
    }

    // --- POPOUT & WORKFLOW LOGIC ---
    function openPopout(type) {
        const popoutWindow = document.getElementById(`md-${type}-popout`);
        const otherType = type === 'editor' ? 'eraser' : 'editor';
        const otherPopout = document.getElementById(`md-${otherType}-popout`);

        // If the other popout is open with changes, prompt before switching
        if (otherPopout.style.display === 'flex' && activePopout.hasChanges && activePopout.type === otherType) {
             handlePopoutClose(activePopout.type, () => {
                 otherPopout.style.display = 'none';
                 popoutWindow.style.display = 'flex';
                 activePopout = { type, hasChanges: false };
                 positionPopoutWindow(popoutWindow, document.getElementById('md-enhancer'));
             });
        } else {
             if(otherPopout) otherPopout.style.display = 'none';
             popoutWindow.style.display = 'flex';
             activePopout = { type, hasChanges: false };
             positionPopoutWindow(popoutWindow, document.getElementById('md-enhancer'));
        }
    }
    function positionPopoutWindow(popoutEl, mainEl) {
        if (!popoutEl || !mainEl) return; popoutEl.style.visibility = 'hidden'; const mainRect = mainEl.getBoundingClientRect(); const popoutWidth = popoutEl.offsetWidth; const gap = 15;
        let newLeft = mainRect.left - popoutWidth - gap; if (newLeft < 0) { newLeft = mainRect.right + gap; }
        popoutEl.style.top = `${mainRect.top}px`; popoutEl.style.left = `${newLeft}px`; popoutEl.style.visibility = 'visible';
    }
    function handlePopoutClose(type, callbackOnClose) {
        if (activePopout.hasChanges && activePopout.type === type) {
            showCustomModal({ title: 'Unsaved Changes', message: `You have unsaved changes. What would you like to do?`, type: 'confirm', okText: 'Save & Close', cancelText: 'Discard & Close',
                onOk: () => {
                    if (type === 'editor') downloadEditorImage();
                    else if (type === 'eraser') downloadEraserImage();
                    activePopout.hasChanges = false;
                    if (callbackOnClose) callbackOnClose();
                },
                onCancel: () => { activePopout.hasChanges = false; if (callbackOnClose) callbackOnClose(); }
            });
        } else { if (callbackOnClose) callbackOnClose(); }
    }

    // --- GENERIC MODAL SYSTEM ---
    function showCustomModal(options) {
        const { title, message, type = 'alert', onOk, onCancel, defaultValue = '', placeholder = '', label = '', okText = 'OK', cancelText = 'Cancel' } = options; const backdrop = document.getElementById('md-generic-modal-backdrop'); const titleEl = document.getElementById('md-generic-modal-title'); const messageEl = document.getElementById('md-generic-modal-message'); const okBtn = document.getElementById('md-generic-modal-ok-btn'); const cancelBtn = document.getElementById('md-generic-modal-cancel-btn'); const inputWrapper = document.getElementById('md-generic-modal-input-wrapper'); const inputEl = document.getElementById('md-generic-modal-input'); const inputLabelEl = document.getElementById('md-generic-modal-input-label'); titleEl.textContent = title; messageEl.textContent = message; inputWrapper.style.display = 'none'; cancelBtn.style.display = 'inline-block'; okBtn.textContent = okText; cancelBtn.textContent = cancelText; if (type === 'alert') { cancelBtn.style.display = 'none'; } else if (type === 'prompt') { inputWrapper.style.display = 'block'; inputLabelEl.textContent = label || message; inputLabelEl.style.display = label ? 'block' : 'none'; messageEl.style.display = label ? 'block' : 'none'; inputEl.value = defaultValue; inputEl.placeholder = placeholder; okBtn.textContent = 'Save'; setTimeout(() => inputEl.focus(), 50); } const newOkBtn = okBtn.cloneNode(true); const newCancelBtn = cancelBtn.cloneNode(true); okBtn.parentNode.replaceChild(newOkBtn, okBtn); cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn); const hide = () => backdrop.style.display = 'none'; newOkBtn.addEventListener('click', () => { hide(); if (onOk) { type === 'prompt' ? onOk(inputEl.value.trim()) : onOk(); } }); newCancelBtn.addEventListener('click', () => { hide(); if (onCancel) onCancel(); }); backdrop.style.display = 'flex';
    }

    // --- INSTRUCTIONS MANAGER LOGIC ---
    const instructionsStorageKey = 'mdEnhancer_customInstructionsJSON';
    const loadInstructionsFromStorage = () => { try { const data = localStorage.getItem(instructionsStorageKey); return data ? JSON.parse(data) : []; } catch (e) { return []; }};
    const saveInstructionsToStorage = (instructions) => { localStorage.setItem(instructionsStorageKey, JSON.stringify(instructions)); };
    function populateInstructionsDropdown() { const select = document.getElementById('md-modal-instructions-select'); const instructions = loadInstructionsFromStorage(); select.innerHTML = ''; if (instructions.length === 0) { select.innerHTML = '<option value="-1">No instructions saved</option>'; document.getElementById('md-modal-instructions-textarea').value = ''; return; } instructions.forEach((item, index) => { const option = document.createElement('option'); option.value = index; option.textContent = item.name; select.appendChild(option); }); loadSelectedInstruction(); }
    function loadSelectedInstruction() { const select = document.getElementById('md-modal-instructions-select'); const textarea = document.getElementById('md-modal-instructions-textarea'); const instructions = loadInstructionsFromStorage(); const selectedIndex = parseInt(select.value, 10); if (selectedIndex >= 0 && instructions[selectedIndex]) { textarea.value = instructions[selectedIndex].content; } else { textarea.value = ''; } initialModalText = textarea.value; }
    function openInstructionsModal() { document.getElementById('md-manager-modal-backdrop').style.display = 'flex'; populateInstructionsDropdown(); }
    function closeInstructionsModal(force = false) { const modalBackdrop = document.getElementById('md-manager-modal-backdrop'); if (!force && document.getElementById('md-modal-instructions-textarea').value !== initialModalText) { showCustomModal({ title: 'Unsaved Changes', message: 'You have unsaved changes. Are you sure you want to close?', type: 'confirm', onOk: () => { modalBackdrop.style.display = 'none'; } }); } else { modalBackdrop.style.display = 'none'; } }
    function pasteAndCloseModal() { const ta = document.querySelector('textarea[placeholder*="emojis"]'); if (ta) { ta.value = document.getElementById('md-modal-instructions-textarea').value; ta.dispatchEvent(new Event('input', { bubbles: true })); } closeInstructionsModal(true); }
    function saveNewInstruction(name, content) { const instructions = loadInstructionsFromStorage(); if (instructions.some(instr => instr.name.toLowerCase() === name.toLowerCase())) { showCustomModal({ title: 'Duplicate Name', message: `An instruction with the name "${name}" already exists. Please choose a different name.`, type: 'alert' }); return false; } instructions.push({ name: name, content: content }); saveInstructionsToStorage(instructions); return true; }
    function addNewInstruction() { showCustomModal({ title: 'New Instruction', label: 'Enter a name for your new instruction:', type: 'prompt', onOk: (name) => { if (name && saveNewInstruction(name, "")) { populateInstructionsDropdown(); document.getElementById('md-modal-instructions-select').value = loadInstructionsFromStorage().length - 1; loadSelectedInstruction(); } } }); }
    function saveSelectedInstruction(button) { const select = document.getElementById('md-modal-instructions-select'); const selectedIndex = parseInt(select.value, 10); if (selectedIndex < 0) { showCustomModal({ title: 'Error', message: 'Please select an instruction to save.', type: 'alert' }); return; } const instructions = loadInstructionsFromStorage(); instructions[selectedIndex].content = document.getElementById('md-modal-instructions-textarea').value; saveInstructionsToStorage(instructions); initialModalText = instructions[selectedIndex].content; copyToClipboard(null, button, "Save", "✅ Saved!"); }
    function deleteSelectedInstruction() { const select = document.getElementById('md-modal-instructions-select'); const selectedIndex = parseInt(select.value, 10); if (selectedIndex < 0) { showCustomModal({ title: 'Error', message: 'Please select an instruction to delete.', type: 'alert' }); return; } showCustomModal({ title: 'Confirm Deletion', message: `Are you sure you want to delete "${select.options[select.selectedIndex].text}"?`, type: 'confirm', onOk: () => { const instructions = loadInstructionsFromStorage(); instructions.splice(selectedIndex, 1); saveInstructionsToStorage(instructions); populateInstructionsDropdown(); } }); }

    // --- HELPER & CORE FUNCTIONS ---
    function copyToClipboard(text, button, defaultText, successText = "✅ Copied!") { if (text !== null) navigator.clipboard.writeText(text); if (button) { button.textContent = successText; setTimeout(() => { button.textContent = defaultText; }, 1500); } }
    function handleFileSelection(e) { const file = e.target.files.length > 0 ? e.target.files[0] : null; if (!file) return; const statusEl = document.getElementById('describer-file-status'), controlsEl = document.getElementById('describer-controls'); if (file.type === 'image/jpeg' || file.type === 'image/png') { describerImageFile = file; statusEl.textContent = file.name; statusEl.style.color = '#555'; controlsEl.style.display = 'block'; } else { describerImageFile = null; statusEl.textContent = "Error: Please choose a JPG or PNG file."; statusEl.style.color = '#dc3545'; controlsEl.style.display = 'none'; } }
    function saveGeminiApiKey() { const keyInput = document.getElementById('settings-api-key'); const statusEl = document.getElementById('settings-gemini-status'); if (keyInput && keyInput.value) { localStorage.setItem('mdEnhancer_geminiApiKey', keyInput.value); statusEl.textContent = "✅ Key Saved!"; statusEl.style.color = '#28a745'; } else { localStorage.removeItem('mdEnhancer_geminiApiKey'); statusEl.textContent = "Key removed."; statusEl.style.color = '#6c757d'; } setTimeout(() => { statusEl.textContent = ''; }, 3000); }
    function runAllCalculations() { calculateProfit(null, true); calculateSuggestedSalePrice(); }

    (function() {
        // --- Pan & Zoom Logic ---
        function setupPanZoom(canvas, panZoomState, onUserInteraction, toolType) {
            const container = canvas.parentElement;

            // CRITICAL FIX: getMousePos must use the container's rect, not the transformed canvas rect.
            const getMousePos = (e) => {
                const rect = container.getBoundingClientRect();
                return { x: e.clientX - rect.left, y: e.clientY - rect.top };
            };

            const screenToWorld = (screenPos) => ({ x: (screenPos.x - panZoomState.panX) / panZoomState.zoom, y: (screenPos.y - panZoomState.panY) / panZoomState.zoom, });
            const applyCssTransform = () => { canvas.style.transformOrigin = '0 0'; canvas.style.transform = `translate(${panZoomState.panX}px, ${panZoomState.panY}px) scale(${panZoomState.zoom})`; };

            container.addEventListener('wheel', e => { e.preventDefault(); const mousePos = getMousePos(e); const worldBefore = screenToWorld(mousePos); const zoomFactor = Math.pow(0.999, e.deltaY); panZoomState.zoom *= zoomFactor; panZoomState.zoom = Math.max(0.1, Math.min(panZoomState.zoom, 10)); const worldAfter = screenToWorld(mousePos); panZoomState.panX += (worldAfter.x - worldBefore.x) * panZoomState.zoom; panZoomState.panY += (worldAfter.y - worldBefore.y) * panZoomState.zoom; applyCssTransform(); });
            container.addEventListener('mousedown', e => { if (e.button === 1) { panZoomState.isPanning = true; panZoomState.lastX = e.clientX; panZoomState.lastY = e.clientY; container.style.cursor = 'grabbing'; e.preventDefault(); } else if (e.button === 0 && onUserInteraction) { onUserInteraction('down', screenToWorld(getMousePos(e))); } });
            container.addEventListener('mousemove', e => { if (panZoomState.isPanning) { const dx = e.clientX - panZoomState.lastX; const dy = e.clientY - panZoomState.lastY; panZoomState.panX += dx; panZoomState.panY += dy; panZoomState.lastX = e.clientX; panZoomState.lastY = e.clientY; applyCssTransform(); } else if (onUserInteraction) { onUserInteraction('move', screenToWorld(getMousePos(e))); } });
            container.addEventListener('mouseup', e => { if (e.button === 1) { panZoomState.isPanning = false; container.style.cursor = toolType === 'eraser' ? 'crosshair' : 'grab'; } else if (onUserInteraction) { onUserInteraction('up', screenToWorld(getMousePos(e))); } });
            container.addEventListener('mouseleave', () => { if (panZoomState.isPanning) { panZoomState.isPanning = false; container.style.cursor = toolType === 'eraser' ? 'crosshair' : 'grab';} if (onUserInteraction) onUserInteraction('up'); });
            applyCssTransform();
            const resetBtnId = canvas.id + '-fit-btn';
            if (!document.getElementById(resetBtnId)) {
                const btn = document.createElement('button'); btn.textContent = 'Fit to View'; btn.id = resetBtnId; btn.classList.add('popout-util-btn');
                btn.onclick = () => {
                    const imageToFit = toolType === 'editor' ? currentImage : eraserOriginalImage;
                    if (imageToFit) zoomToFit(imageToFit.width, imageToFit.height, container, panZoomState, canvas);
                };
                container.appendChild(btn);
            }
        }

        function zoomToFit(imageWidth, imageHeight, container, panZoomState, canvas) {
            const containerRect = container.getBoundingClientRect(); const padding = 20;
            const containerW = containerRect.width - padding; const containerH = containerRect.height - padding;
            const zoom = Math.min(containerW / imageWidth, containerH / imageHeight);
            panZoomState.zoom = zoom < 1 ? zoom : 1;
            panZoomState.panX = (containerRect.width - imageWidth * panZoomState.zoom) / 2;
            panZoomState.panY = (containerRect.height - imageHeight * panZoomState.zoom) / 2;
            canvas.style.transformOrigin = '0 0'; canvas.style.transform = `translate(${panZoomState.panX}px, ${panZoomState.panY}px) scale(${panZoomState.zoom})`;
        }


        // --- Editor Functions ---
        handleImageUpload = function(e) {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = function(event) {
                const img = new Image();
                img.onload = function() {
                    editorCanvas = document.getElementById('editor-canvas'); editorCtx = editorCanvas.getContext('2d', { willReadFrequently: true });
                    currentImage = img; currentImage.name = file.name;
                    editorCanvas.width = img.width; editorCanvas.height = img.height;
                    editorCtx.drawImage(img, 0, 0);
                    originalImageData = editorCtx.getImageData(0, 0, img.width, img.height);
                    if (editorWorker) editorWorker.terminate();
                    editorWorker = new Worker(workerUrl);
                    editorWorker.onmessage = function(msg) { if (msg.data.type === 'result') { editorCtx.putImageData(msg.data.newImageData, 0, 0); document.getElementById('editor-status').textContent = 'Ready'; document.getElementById('editor-status').style.color = '#28a745'; } };
                    editorWorker.postMessage({ type: 'init', payload: { imageData: originalImageData } });
                    const container = document.getElementById('editor-canvas-container');
                    zoomToFit(img.width, img.height, container, editorPanZoom, editorCanvas);
                    document.getElementById('editor-main-content').style.display = 'block'; document.getElementById('editor-placeholder-text').style.display = 'none';
                    resetEditor(false);
                    setupPanZoom(editorCanvas, editorPanZoom, null, 'editor');
                    let resizeDebounce;
                    const resizeObserver = new ResizeObserver(() => { clearTimeout(resizeDebounce); resizeDebounce = setTimeout(() => { if (currentImage) zoomToFit(currentImage.width, currentImage.height, container, editorPanZoom, editorCanvas); }, 100); });
                    resizeObserver.observe(container);
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        };
        postToWorker = function() { clearTimeout(debounceTimer); const statusEl = document.getElementById('editor-status'); statusEl.textContent = 'Processing...'; statusEl.style.color = '#6c757d'; debounceTimer = setTimeout(() => { if (!editorWorker) return; const adjustments = { vibrance: parseInt(document.getElementById('editor-vibrance-slider').value, 10), saturation: parseInt(document.getElementById('editor-saturation-slider').value, 10), brightness: parseInt(document.getElementById('editor-brightness-slider').value, 10), contrast: parseInt(document.getElementById('editor-contrast-slider').value, 10), exposure: parseInt(document.getElementById('editor-exposure-slider').value, 10), hue: parseInt(document.getElementById('editor-hue-slider').value, 10), temperature: parseInt(document.getElementById('editor-temperature-slider').value, 10), tint: parseInt(document.getElementById('editor-tint-slider').value, 10), invert: parseInt(document.getElementById('editor-invert-slider').value, 10), grayscale: parseInt(document.getElementById('editor-grayscale-slider').value, 10) }; editorWorker.postMessage({ type: 'apply', payload: { adjustments } }); }, 100); };
        resetEditor = function(resetZoom = true) {
            if (!originalImageData) return;
            ['vibrance', 'saturation', 'brightness', 'contrast', 'exposure', 'hue', 'temperature', 'tint', 'invert', 'grayscale'].forEach(name => {
                const slider = document.getElementById(`editor-${name}-slider`); const valueSpan = document.getElementById(`editor-${name}-value`);
                if (slider) slider.value = 0; if (valueSpan) valueSpan.textContent = '0';
            });
            editorCtx.putImageData(originalImageData, 0, 0); const statusEl = document.getElementById('editor-status'); statusEl.textContent = 'Ready'; statusEl.style.color = '#6c757d';
            if (resetZoom && currentImage) {
                const container = document.getElementById('editor-canvas-container');
                zoomToFit(currentImage.width, currentImage.height, container, editorPanZoom, editorCanvas);
            }
            activePopout.hasChanges = false;
        };
        downloadEditorImage = function() { if (!editorCanvas || !currentImage) return; const link = document.createElement('a'); const fileName = currentImage.name ? currentImage.name.replace(/\.[^/.]+$/, "") + "-edited.png" : "edited-image.png"; link.download = fileName; link.href = editorCanvas.toDataURL('image/png'); link.click(); activePopout.hasChanges = false; };

        // --- Eraser Functions ---
        handleEraserUpload = function(e) {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = function(event) {
                const img = new Image();
                img.onload = function() {
                    eraserCanvas = document.getElementById('eraser-canvas'); eraserCtx = eraserCanvas.getContext('2d', { willReadFrequently: true });
                    eraserOriginalImage = img;
                    eraserCanvas.width = img.width; eraserCanvas.height = img.height;
                    eraserCtx.drawImage(img, 0, 0);
                    const container = document.getElementById('eraser-canvas-container');
                    zoomToFit(img.width, img.height, container, eraserPanZoom, eraserCanvas);
                    document.getElementById('eraser-main-content').style.display = 'block';
                    document.getElementById('eraser-placeholder-text').style.display = 'none';
                    resetEraser(false);
                    const erase = (worldPos) => {
                        if (!eraserCtx || !isErasing) return;
                        eraserCtx.save();
                        eraserCtx.globalCompositeOperation = 'destination-out';
                        eraserCtx.beginPath();
                        const brushRadius = eraserBrushSize / 2;
                        eraserCtx.arc(worldPos.x, worldPos.y, brushRadius, 0, Math.PI * 2);
                        eraserCtx.fill();
                        eraserCtx.restore();
                        activePopout.hasChanges = true;
                    };
                    const eraserInteraction = (action, worldPos) => {
                        switch(action) {
                            case 'down': isErasing = true; if (worldPos) erase(worldPos); break;
                            case 'move': if (isErasing && worldPos) erase(worldPos); break;
                            case 'up': isErasing = false; break;
                        }
                    };
                    setupPanZoom(eraserCanvas, eraserPanZoom, eraserInteraction, 'eraser');
                    let resizeDebounce;
                    const resizeObserver = new ResizeObserver(() => { clearTimeout(resizeDebounce); resizeDebounce = setTimeout(() => { if (eraserOriginalImage) zoomToFit(eraserOriginalImage.width, eraserOriginalImage.height, container, eraserPanZoom, eraserCanvas); }, 100); });
                    resizeObserver.observe(container);
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        };
        resetEraser = function(resetZoom = true) {
            if (!eraserCtx || !eraserOriginalImage) return;
            eraserCtx.clearRect(0, 0, eraserCanvas.width, eraserCanvas.height);
            eraserCtx.drawImage(eraserOriginalImage, 0, 0);
            if (resetZoom) {
                const container = document.getElementById('eraser-canvas-container');
                zoomToFit(eraserOriginalImage.width, eraserOriginalImage.height, container, eraserPanZoom, eraserCanvas);
            }
            activePopout.hasChanges = false;
        };
        downloadEraserImage = function() { if (!eraserCanvas) return; const link = document.createElement('a'); link.download = 'erased-image.png'; link.href = eraserCanvas.toDataURL('image/png'); link.click(); activePopout.hasChanges = false; };


        const callGeminiAPI = (apiKey, requestBody, statusEl, onSuccess) => { GM_xmlhttpRequest({ method: "POST", url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, headers: {"Content-Type": "application/json"}, data: JSON.stringify(requestBody), onload: function(response) { try { const data = JSON.parse(response.responseText); if (data.candidates && data.candidates[0]) { onSuccess(data.candidates[0].content.parts[0].text); } else { statusEl.textContent = `Error: ${data.error?.message || 'Invalid API response.'}`; statusEl.style.color = '#dc3545'; } } catch (err) { statusEl.textContent = "Error: Failed to parse API response."; statusEl.style.color = '#dc3545'; } }, onerror: function(error) { statusEl.textContent = "Error: Network request failed."; statusEl.style.color = '#dc3545'; console.error("Gemini API Error:", error); } }); };
        describeImage = function() { const apiKey = localStorage.getItem('mdEnhancer_geminiApiKey'); const statusEl = document.getElementById('describer-status'); if (!apiKey) { showCustomModal({title: "API Key Missing", message: "A Gemini API key is required for this feature. Please add one in the Settings tab.", type: "alert"}); return; } if (!describerImageFile) { showCustomModal({title: "No Image Selected", message: "Please choose an image file first.", type: "alert"}); return; } statusEl.textContent = "🔎 Describing image..."; statusEl.style.color = '#6c757d'; document.getElementById('describer-results-wrapper').style.display = 'none'; const reader = new FileReader(); reader.onload = function(e) { const base64Data = e.target.result.split(',')[1]; const prompt = `You are an SEO expert for print-on-demand products. Describe this image for product listing tags and a product description. The tone should be appealing to online shoppers. Focus on objects, style, mood, and potential use cases. Crucially, if the image contains any text, please transcribe it exactly and describe its font style (e.g., retro, script, bold) as part of the main description. Format the output with 'Tags:' on one line with comma-separated values, and 'Description:' on a new line.`; const requestBody = { "contents": [{"parts": [ {"text": prompt }, {"inline_data": {"mime_type": describerImageFile.type, "data": base64Data }} ]}] }; callGeminiAPI(apiKey, requestBody, statusEl, (fullText) => { let tags = 'Could not parse tags.'; let description = fullText; const tagsMatch = fullText.match(/Tags:(.*)/i); const descMatch = fullText.match(/Description:(.*)/is); if (tagsMatch) tags = tagsMatch[1].split('\n')[0].trim(); if (descMatch) description = descMatch[1].trim(); document.getElementById('describer-tags-result').value = tags; document.getElementById('describer-desc-result').value = description; statusEl.textContent = "✅ Description generated!"; statusEl.style.color = '#28a745'; document.getElementById('describer-results-wrapper').style.display = 'block'; }); }; reader.readAsDataURL(describerImageFile); };
        calculateProfit = function(initialSalePrice = null, updateUI = false) { const getVal = id => parseFloat(document.getElementById(id)?.value) || 0; let salePricePerItem = initialSalePrice !== null ? initialSalePrice : getVal('pc-sale-price'); const shippingPriceCustomer = getVal('pc-shipping-price-customer'), itemQuantity = Math.max(1, getVal('pc-item-quantity')), discountValue = getVal('pc-discount-value'), discountType = document.getElementById('pc-discount-type')?.value; const costPerItem = getVal('pc-cost-per-item'), actualShippingCost = getVal('pc-actual-shipping-cost'), listingFee = getVal('pc-listing-fee') || 0.20, transactionFeePercent = getVal('pc-transaction-fee-percent') || 6.5; const paymentProcessingPercent = 0.03, paymentProcessingFlat = 0.25, advertisingCostVal = getVal('pc-advertising-cost'), advertisingType = document.getElementById('pc-advertising-type')?.value, miscCostVal = getVal('pc-misc-cost'), miscType = document.getElementById('pc-misc-type')?.value; let totalDiscountAmount = (discountType === 'percent') ? (salePricePerItem * (discountValue / 100)) * itemQuantity : discountValue * itemQuantity; const totalSalePriceAfterDiscount = (salePricePerItem * itemQuantity) - totalDiscountAmount, proceeds = totalSalePriceAfterDiscount + (shippingPriceCustomer * itemQuantity); const totalCostPerItem = costPerItem * itemQuantity, totalActualShippingCost = actualShippingCost * itemQuantity, etsyTransactionFee = proceeds * (transactionFeePercent / 100), paymentFee = (proceeds * paymentProcessingPercent) + paymentProcessingFlat; let advertisingCost = (advertisingType === 'percent') ? (proceeds * (advertisingCostVal / 100)) : advertisingCostVal * itemQuantity; let miscCosts = (miscType === 'percent') ? (proceeds * (miscCostVal / 100)) : miscCostVal * itemQuantity; const totalCosts = totalCostPerItem + totalActualShippingCost + listingFee + etsyTransactionFee + paymentFee + advertisingCost + miscCosts, netProfit = proceeds - totalCosts; const returnOnInvestment = totalCosts > 0 ? (netProfit / totalCosts) * 100 : 0, profitMargin = proceeds > 0 ? (netProfit / proceeds) * 100 : 0; if (updateUI) { document.getElementById('pc-proceeds').textContent = `$${proceeds.toFixed(2)}`; document.getElementById('pc-total-costs').textContent = `$${totalCosts.toFixed(2)}`; document.getElementById('pc-net-profit').textContent = `$${netProfit.toFixed(2)}`; document.getElementById('pc-return').textContent = `${returnOnInvestment.toFixed(2)}%`; document.getElementById('pc-margin').textContent = `${profitMargin.toFixed(2)}%`; } return { netProfit }; };
        calculateSuggestedSalePrice = function() { const goalValue = parseFloat(document.getElementById('pc-goal-value')?.value) || 0; let low = 0.01, high = 10000.00, suggestedPrice = 0, iterations = 0; while (low <= high && iterations < 100) { suggestedPrice = (low + high) / 2; const { netProfit } = calculateProfit(suggestedPrice, false); if (Math.abs(netProfit - goalValue) < 0.01) break; else if (netProfit < goalValue) low = suggestedPrice + 0.01; else high = suggestedPrice - 0.01; iterations++; } document.getElementById('pc-suggested-sale-price').textContent = (iterations < 100) ? `$${suggestedPrice.toFixed(2)}` : `$N/A`; };
        createKeywordRow = (k) => `<div class="niche-keyword-row"><span>${k}</span><button class="niche-copy-btn" data-keyword="${k}">Copy</button></div>`;
        findRankedKeywords = async function() { const baseKeyword = document.getElementById('niche-keyword').value.trim(); const statusEl = document.getElementById('niche-status'); const resultsContainer = document.getElementById('niche-results-container'); if (!baseKeyword) { showCustomModal({ title: "Input Required", message: "Please enter a Main Design Subject.", type: 'alert' }); return; } statusEl.textContent = '🔎 Searching Etsy, Amazon & Google...'; resultsContainer.innerHTML = ''; const fetchGoogleSuggestions = q => new Promise(r => GM_xmlhttpRequest({ method: "GET", url: `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`, onload: res => { try { r(JSON.parse(res.responseText)[1] || []); } catch (e) { r([]); } }, onerror: () => r([]) })); const fetchAmazonSuggestions = q => new Promise(r => GM_xmlhttpRequest({ method: "GET", url: `https://completion.amazon.com/search/complete?search-alias=aps&client=amazon-search-ui&mkt=1&q=${encodeURIComponent(q)}`, onload: res => { try { r(JSON.parse(res.responseText)[1] || []); } catch (e) { r([]); } }, onerror: () => r([]) })); const fetchRedbubbleTrending = () => new Promise(resolve => { const rbUrl = `https://www.redbubble.com/api/explore/searches/trending`; const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(rbUrl)}`; GM_xmlhttpRequest({ method: "GET", url: proxyUrl, onload: res => { try { const proxyResponse = JSON.parse(res.responseText); const rbData = JSON.parse(proxyResponse.contents); const trends = rbData.results.map(item => item.query); resolve(trends || []); } catch (e) { console.error("Error parsing Redbubble data:", e); resolve([]); } }, onerror: (err) => { console.error("Proxy error for Redbubble:", err); resolve([]); } }); }); const podProducts = ['shirt', 't-shirt', 'sticker', 'mug', 'png', 'svg', 'design', 'tumbler wrap', 'hoodie']; const alphabet = "abcdefghijklmnopqrstuvwxyz".split(''); const trendPromise = fetchRedbubbleTrending(); const productPromises = podProducts.flatMap(product => [ fetchGoogleSuggestions(`${baseKeyword} ${product}`), fetchAmazonSuggestions(`${baseKeyword} ${product}`) ]); const generalPromises = alphabet.flatMap(c => [ fetchGoogleSuggestions(`${baseKeyword} ${c}`), fetchAmazonSuggestions(`${baseKeyword} ${c}`) ]); const [trendingResults, productResults, generalResults] = await Promise.all([ trendPromise, Promise.all(productPromises), Promise.all(generalPromises) ]); const trendingKeywords = new Set(trendingResults.map(k => k.toLowerCase())); const productKeywords = new Set(productResults.flat().map(k => k.toLowerCase())); const generalKeywords = new Set(generalResults.flat().map(k => k.toLowerCase())); productKeywords.forEach(k => { trendingKeywords.delete(k); }); generalKeywords.forEach(k => { trendingKeywords.delete(k); productKeywords.delete(k); }); const sortedTrends = Array.from(trendingKeywords); const sortedProducts = Array.from(productKeywords); const sortedGeneral = Array.from(generalKeywords).sort(); statusEl.textContent = `✅ Found ${sortedTrends.length} trends, ${sortedProducts.length} product keywords, ${sortedGeneral.length} general ideas.`; let html = ''; if (sortedTrends.length > 0) { html += `<h4>🔥 Etsy Trending Now</h4>`; html += `<p class="md-hint" style="text-align:left;font-size:12px;">Live trending searches on Etsy for market research.</p>`; html += sortedTrends.map(k => createKeywordRow(k)).join(''); } if (sortedProducts.length > 0) { html += `<div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px;"><h4>💡 Product-Specific Keywords</h4><button id="ldd-copy-all-tags-btn" class="niche-copy-btn" style="width: auto !important; padding: 4px 8px !important;">Copy 13 Tags</button></div>`; html += `<p class="md-hint" style="text-align:left;font-size:12px;">Keywords for specific products (shirts, stickers, mugs, etc.). Best for your tags.</p>`; html += sortedProducts.map(k => createKeywordRow(k)).join(''); } if (sortedGeneral.length > 0) { html += `<h4 style="margin-top:15px;">🏷️ General Niche Keywords</h4>`; html += `<p class="md-hint" style="text-align:left;font-size:12px;">Broader and long-tail ideas related to your main subject.</p>`; html += sortedGeneral.map(k => createKeywordRow(k)).join(''); } if (html.length === 0) { resultsContainer.innerHTML = `<p>No keywords found. This can happen with very niche terms. Try a broader subject.</p>`; } else { resultsContainer.innerHTML = html; } const copyAllBtn = document.getElementById('ldd-copy-all-tags-btn'); if (copyAllBtn) { copyAllBtn.addEventListener('click', (e) => { const etsyTags = sortedProducts.filter(tag => tag.length <= 20).slice(0, 13); const tagString = etsyTags.join(','); copyToClipboard(tagString, e.target, 'Copy 13 Tags', `✅ Copied ${etsyTags.length} Tags!`); }); } };
        syncToStorage = function() { const ids = [ 'md-main-word', 'md-product-type', 'md-custom-type', 'niche-keyword', 'pc-sale-price', 'pc-shipping-price-customer', 'pc-item-quantity', 'pc-discount-value', 'pc-discount-type', 'pc-cost-per-item', 'pc-actual-shipping-cost', 'pc-listing-fee', 'pc-transaction-fee-percent', 'pc-advertising-cost', 'pc-advertising-type', 'pc-misc-cost', 'pc-misc-type', 'pc-goal-value', 'settings-api-key' ]; ids.forEach(id => { const el = document.getElementById(id); if (el) localStorage.setItem(`mdEnhancer_${id}`, el.value); }); };
        loadFromStorage = function() { const defaults = {'pc-sale-price': '10.00','pc-shipping-price-customer': '0.00','pc-item-quantity': '1','pc-discount-value': '0.00','pc-discount-type': 'flat','pc-cost-per-item': '5.00','pc-actual-shipping-cost': '0.00','pc-listing-fee': '0.20','pc-transaction-fee-percent': '6.5','pc-advertising-cost': '0.00','pc-advertising-type': 'percent','pc-misc-cost': '0.00','pc-misc-type': 'percent','pc-goal-value': '5.00'}; Object.keys(defaults).forEach(id => { const el = document.getElementById(id); if(el) el.value = localStorage.getItem(`mdEnhancer_${id}`) || defaults[id]; }); ['md-main-word', 'md-product-type', 'md-custom-type', 'niche-keyword'].forEach(id => { const el = document.getElementById(id); if(el) el.value = localStorage.getItem(`mdEnhancer_${id}`) || ''; }); document.getElementById('settings-api-key').value = localStorage.getItem('mdEnhancer_geminiApiKey') || ''; };
        makeDraggable = function(element, handle) { if (!element || !handle) return; let p1=0, p2=0, p3=0, p4=0; handle.onmousedown = e => { e.preventDefault(); p3 = e.clientX; p4 = e.clientY; document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; }; document.onmousemove = me => { me.preventDefault(); p1 = p3 - me.clientX; p2 = p4 - me.clientY; p3 = me.clientX; p4 = me.clientY; element.style.top = (element.offsetTop - p2) + "px"; element.style.left = (element.offsetLeft - p1) + "px"; }; }; };
        makeResizable = function(element, handle) { if (!element || !handle) return; handle.addEventListener('mousedown', function(e) { e.preventDefault(); let startX = e.clientX, startY = e.clientY, startWidth = parseInt(getComputedStyle(element).width), startHeight = parseInt(getComputedStyle(element).height); const doDrag = de => { let newWidth = startWidth + de.clientX - startX; let newHeight = startHeight + de.clientY - startY; if (newWidth > 400) element.style.width = newWidth + 'px'; if (newHeight > 300) element.style.height = newHeight + 'px'; }; const stopDrag = () => { document.documentElement.removeEventListener('mousemove', doDrag, false); document.documentElement.removeEventListener('mouseup', stopDrag, false); }; document.documentElement.addEventListener('mousemove', doDrag, false); document.documentElement.addEventListener('mouseup', stopDrag, false); }); };
    })();

    // --- DPI Helper Functions (moved to accessible scope) ---
    function create300DPIChunk(dpi) {
        const pxPerMeter = Math.round(dpi * 39.3701);
        const data = new Uint8Array([
            (pxPerMeter >> 24) & 0xff, (pxPerMeter >> 16) & 0xff,
            (pxPerMeter >> 8) & 0xff, pxPerMeter & 0xff,
            (pxPerMeter >> 24) & 0xff, (pxPerMeter >> 16) & 0xff,
            (pxPerMeter >> 8) & 0xff, pxPerMeter & 0xff,
            1 // unit = meter
        ]);
        return createPNGChunk('pHYs', data);
    }
    function createPNGChunk(type, data) {
        const crcTable = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
            }
            crcTable[n] = c;
        }
        function crc32(buf) {
            let crc = 0xffffffff;
            for (let i = 0; i < buf.length; i++) {
                crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
            }
            return (crc ^ 0xffffffff) >>> 0;
        }
        const typeBytes = Array.from(type).map(c => c.charCodeAt(0));
        const chunkData = new Uint8Array([...typeBytes, ...data]);
        const crc = crc32(chunkData);
        const result = new Uint8Array(12 + data.length);
        const length = data.length;
        result[0] = (length >> 24) & 0xff;
        result[1] = (length >> 16) & 0xff;
        result[2] = (length >> 8) & 0xff;
        result[3] = length & 0xff;
        result.set(typeBytes, 4);
        result.set(data, 8);
        result.set([
            (crc >> 24) & 0xff, (crc >> 16) & 0xff,
            (crc >> 8) & 0xff, crc & 0xff
        ], 8 + length);
        return result;
    }
    function insertDPIIntoPNG(png, chunk) {
        const head = png.slice(0, 33);
        const tail = png.slice(33);
        const newPng = new Uint8Array(head.length + chunk.length + tail.length);
        newPng.set(head, 0);
        newPng.set(chunk, head.length);
        newPng.set(tail, head.length + chunk.length);
        return newPng;
    }


    // --- CSS STYLES ---
    GM_addStyle(`
        #md-enhancer { position: fixed; top: 100px; right: 20px; min-width: 460px; max-width: 90vw; min-height: 650px; max-height: 90vh; resize: none; overflow: hidden; background: #ffffff; color: #000000; border-radius: 10px; padding: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.2); z-index: 10000; transition: right 0.3s ease, opacity 0.3s ease; opacity: 0; display: flex; flex-direction: column; }
        #md-enhancer.visible { right: 20px; opacity: 1; } #md-enhancer.hidden { right: -500px; opacity: 0; }
        #md-toggle-wrapper { position: fixed; bottom: 20px; right: 20px; z-index: 10001; cursor: pointer; } #md-toggle-icon { width: 40px; height: 40px; border-radius: 50%; }
        #md-close, .popout-close-btn { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; cursor: pointer; z-index: 10; }
        .enhancer-header { font-weight: bold; padding-bottom: 8px; font-size: 14px; text-align: center; user-select: none; cursor: grab; }
        .tab-header { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-bottom: 10px; padding-bottom: 5px; border-bottom: 1px solid #dddddd; }
        .tab { padding: 6px 10px; cursor: pointer; background: #f0f0f0; border-radius: 6px; color: #000000; font-size: 12px; text-align: center; white-space: nowrap; flex: 1 1 auto;}
        .tab.active { background: #28a745; color: white; font-weight: bold; }
        .md-hint { display: block; color: #555555; font-size: 11px; margin-bottom: 3px; text-align: center; }
        #md-enhancer label, .md-popout-window label { display: block; margin-bottom: 2px; margin-top: 5px; font-size: 13px; color: #000000; }
        #md-enhancer input, #md-enhancer select, #md-enhancer textarea, .md-popout-window input, .md-popout-window select { width: 100%; margin-bottom: 8px; padding: 8px 6px; border-radius: 5px; box-sizing: border-box; font-size: 14px; }
        #md-enhancer button, .md-popout-window button { width: 100%; margin-bottom: 6px; padding: 5px 6px; border-radius: 5px; box-sizing: border-box; background: #28a745; color: white; border: none; font-size: 13px; cursor: pointer; }
        #md-enhancer button:hover, .md-popout-window button:hover { background: #218838; }
        .popout-launcher-btn { padding: 12px !important; font-size: 15px !important; margin-top: 20px !important; }
        #md-enhancer input[type="number"], .md-popout-window input[type="number"] { -moz-appearance: textfield; }
        #md-enhancer input::-webkit-outer-spin-button, #md-enhancer input::-webkit-inner-spin-button, .md-popout-window input::-webkit-outer-spin-button, .md-popout-window input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        #md-enhancer input:not([type="radio"]), #md-enhancer select, .md-popout-window input:not([type="radio"]), .md-popout-window select { border: 1px solid #cccccc; background: #ffffff; color: #000000; }
        #md-enhancer textarea { font-size: 13px; border: 1px solid #cccccc; background: #ffffff; color: #000000; min-height: 60px; }
        .tab-content { flex-grow: 1; overflow-y: auto; padding: 5px 5px; }
        .popout-launcher-content { text-align: center; margin-top: 30px; }
        .profit-section { background: #f9f9f9; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
        .profit-section h3, .niche-h3 { margin: 0 0 10px 0; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee; padding-bottom: 6px; }
        .pc-input-row { display: flex; align-items: center; margin-bottom: 8px; flex-wrap: nowrap; }
        .pc-input-row label { flex-shrink: 0; width: 50%; white-space: nowrap; margin-right: 8px; text-align: right; }
        .pc-input-row input[type="number"] { flex-grow: 1; width: auto; margin-bottom: 0; }
        .pc-cost-toggle { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
        .pc-cost-toggle input { flex-grow: 1; margin-bottom: 0; } .pc-cost-toggle select { flex-grow: 0; width: 60px; margin-bottom: 0; }
        .pc-result-line { margin: 6px 0; font-size: 14px; } .pc-result-line strong { font-size: 15px; }
        .profit-section hr, .section-divider { border: 0; border-top: 1px solid #dddddd; margin: 12px 0; }
        .enhancer-footer { display: flex; justify-content: center; align-items: center; gap: 10px; text-align: center; margin-top: auto; padding-top: 8px; border-top: 1px solid #dddddd; font-size: 11px; color: #888; flex-shrink: 0; }
        .footer-link { color: #555555; text-decoration: none; } .footer-link:hover { color: #000000; }
        .bmc-button { height: 28px; width: auto; }
        #md-resize-handle, .popout-resize-handle { position: absolute; width: 15px; height: 15px; bottom: 0; right: 0; background: rgba(0,0,0,0.1); cursor: nwse-resize; z-index: 10; border-bottom-right-radius: 10px; }
        #niche-results-container { border: 1px solid #dddddd; border-radius: 5px; margin-top: 10px; max-height: 400px; overflow-y: auto; padding: 8px; background: #ffffff;}
        #niche-results-container h4 { color: #1e7e34; margin: 8px 0 4px 0; font-size: 14px; padding-bottom: 3px; border-bottom: 1px solid #eeeeee; }
        .niche-keyword-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 2px; border-bottom: 1px solid #f0f0f0; }
        .niche-keyword-row:last-child { border-bottom: none; }
        .niche-keyword-row span { word-break: break-all; }
        .niche-copy-btn { width: 60px !important; padding: 3px 6px !important; font-size: 12px !important; margin-left: 8px !important; margin-bottom: 0 !important; flex-shrink: 0; background-color: #6c757d !important; }
        .niche-copy-btn:hover { background-color: #5a6268 !important; }
        .file-input-label { display: block; width: 100%; padding: 6px; border-radius: 5px; background: #28a745; color: white; font-size: 13px; cursor: pointer; text-align: center; transition: background-color 0.2s; margin-bottom: 5px; }
        .file-input-label:hover { background: #218838; }
        #describer-file-status { text-align: center; font-size: 12px; color: #555; height: 16px; margin-bottom: 10px; }
        #describer-status { text-align: center; margin-top: 5px; font-size: 13px; height: 16px; margin-bottom: 10px; }
        .settings-link { color: #1e7e34; text-decoration: none; display: block; text-align: center; margin: 2px 0 8px 0; font-size: 12px; }
        .settings-link:hover { text-decoration: underline; }
        .api-status { text-align:center; height: 16px; font-size: 13px; }

        /* Popout Windows Styles */
        .md-popout-window { position: fixed; top: 100px; left: 20px; width: 800px; height: 600px; min-width: 400px; min-height: 300px; background: #ffffff; color: #000000; border-radius: 10px; padding: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); z-index: 10002; display: flex; flex-direction: column; resize: none; overflow: hidden; }
        .popout-main-content { display: flex; flex-grow: 1; gap: 10px; margin-top: 10px; min-height: 0; }
        .popout-controls-panel { width: 280px; flex-shrink: 0; overflow-y: auto; padding-right: 5px; display: flex; flex-direction: column; }
        .popout-canvas-container { flex-grow: 1; display: flex; position: relative; justify-content: start; align-items: start; overflow: hidden; background: #f0f0f0; border-radius: 5px; }
        #editor-canvas-container { cursor: grab; }
        #eraser-canvas-container {
             background-color: #ccc;
             background-image: linear-gradient(45deg, #aaa 25%, transparent 25%), linear-gradient(-45deg, #aaa 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #aaa 75%), linear-gradient(-45deg, transparent 75%, #aaa 75%);
             background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
             cursor: crosshair;
        }
        .popout-canvas-container:active { cursor: grabbing; }
        .canvas-placeholder-text { color: #666; font-size: 14px; text-align: center; width: 100%; align-self: center; }
        #editor-canvas, #eraser-canvas { display: block; max-width: none !important; max-height: none !important; }
        .canvas-hint { position: absolute; bottom: 10px; left: 10px; background: rgba(255,255,255,0.7); color: #000000; padding: 3px 6px; border-radius: 4px; font-size: 11px; z-index: 10; pointer-events: none; }
        .popout-util-btn { position: absolute; bottom: 10px; right: 10px; z-index: 10; font-size: 12px !important; padding: 4px 8px !important; background: #6c757d !important; color: white; border: none; border-radius: 4px; cursor: pointer; width: auto !important; margin-bottom: 0 !important; }
        .popout-util-btn:hover { background-color: #5a6268 !important; }
        .editor-group-header { margin: 12px 0 4px 0; font-size: 13px; font-weight: bold; color: #444444; border-bottom: 1px solid #eeeeee; padding-bottom: 3px; }
        .editor-buttons-row { display: flex; gap: 10px; margin-top: 15px; }
        .editor-buttons-row button { margin: 0; }

        /* Slider Styles */
        input[type="range"] {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 8px;
            background: #e9ecef;
            border-radius: 5px;
            outline: none;
            padding: 0;
            margin-bottom: 10px;
        }
        input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            background: #28a745;
            cursor: pointer;
            border-radius: 50%;
        }
        input[type="range"]::-moz-range-thumb {
            width: 18px;
            height: 18px;
            background: #28a745;
            cursor: pointer;
            border-radius: 50%;
            border: none;
        }
        #resize-dpi-slider {
             width: 44px !important;
             height: 24px !important;
             padding: 0 !important;
             border-radius: 12px !important;
             background-color: #cccccc;
             position: relative;
             vertical-align: middle;
             transition: background-color 0.2s ease;
        }
        #resize-dpi-slider::-webkit-slider-thumb {
             width: 20px;
             height: 20px;
             background: #fff;
             border: 1px solid #ccc;
        }
        #resize-dpi-slider::-moz-range-thumb {
             width: 20px;
             height: 20px;
             background: #fff;
             border: 1px solid #ccc;
        }

        /* Modal Styles */
        #md-manager-modal-backdrop, #md-generic-modal-backdrop { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 10003; display: flex; justify-content: center; align-items: center; }
        #md-custom-instructions-modal, #md-generic-modal { position: relative; background: #ffffff; padding: 25px; border-radius: 8px; width: 90%; max-width: 550px; border: 1px solid #dddddd; box-shadow: 0 5px 15px rgba(0,0,0,0.2); color: #000000; display: flex; flex-direction: column; gap: 12px; }
        #md-manager-modal-close-btn { position: absolute; top: 10px; right: 10px; width: 24px; height: 24px; cursor: pointer; z-index: 10; }
        #md-custom-instructions-modal h3, #md-generic-modal h3 { margin: 0; font-size: 18px; color: #000000; text-align: center; }
        #md-generic-modal p { margin: 0; text-align: center; color: #555555; font-size: 14px; }
        #md-modal-instructions-textarea { width: 100%; box-sizing: border-box; background: #f0f0f0; color: #000000; border: 1px solid #cccccc; border-radius: 5px; padding: 10px; font-size: 14px; resize: vertical; }
        #md-generic-modal-input-wrapper { display: flex; flex-direction: column; gap: 4px; }
        #md-generic-modal-input-wrapper label { font-size: 13px; color: #555555; }
        #md-generic-modal-input { width: 100%; margin: 0; padding: 8px 6px; border-radius: 5px; box-sizing: border-box; font-size: 14px; border: 1px solid #cccccc; background: #ffffff; color: #000000; }
        .modal-button-row { display: flex; gap: 10px; margin-top: 5px; }
        .modal-button-row button { flex: 1; margin-bottom: 0 !important; }
        .modal-controls-row { display: flex; gap: 8px; align-items: center; }
        .modal-controls-row select { flex-grow: 1; margin: 0; padding: 6px; border: 1px solid #cccccc; background: #ffffff; color: #000000; border-radius: 5px;}
        .modal-manage-btn { padding: 6px 12px !important; flex-shrink: 0; font-size: 12px !important; background-color: #6c757d !important; margin-bottom: 0 !important; }
        .modal-manage-btn:hover { background-color: #5a6268 !important; }
        .modal-secondary-btn { background-color: #6c757d !important; }
        .modal-secondary-btn:hover { background-color: #5a6268 !important; }
    `);
})();
