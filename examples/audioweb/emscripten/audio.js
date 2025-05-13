// include em.js before this file

// Function pointers to get the audio from emscripten
let getSamples = null;
let setParameter = null;
let update = null;
let audioWorkletNode = null;
let audioContext = null;

// you can only start calling c++ functions once emscripten's "runtime" has started
Module.onRuntimeInitialized = async function() {
    console.log("WebAssembly runtime initialized");
    
    // Debugging information about the Module
    console.log("Module status:", {
        hasHeapU8: !!Module.HEAPU8,
        hasBuffer: Module.HEAPU8 ? !!Module.HEAPU8.buffer : false,
        heap8Size: Module.HEAPU8 ? Module.HEAPU8.length : 0,
        malloc: typeof Module._malloc === 'function' ? 'available' : 'not available'
    });
    
    // Wait a bit longer for memory to be fully initialized
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Wrap C++ functions
    try {
        getSamples = Module.cwrap(
            'getSamples', 'number', ['number', 'number', 'number']
        );
        setParameter = Module.cwrap('setParameter', null, ['string', 'string']);
        update = Module.cwrap('update', null, null);
        console.log("C++ functions wrapped successfully");
    } catch (e) {
        console.error("Error wrapping C++ functions:", e);
    }
    
    // Alternative method: Use a direct heap creation if HEAPU8 isn't available
    const createHeap = () => {
        if (!Module.HEAPU8 && Module.buffer) {
            console.log("Creating HEAPU8 from Module.buffer");
            Module.HEAPU8 = new Uint8Array(Module.buffer);
            return true;
        } else if (!Module.HEAPU8 && typeof Module._malloc === 'function') {
            console.log("Module is initialized but HEAPU8 is not available. Forcing memory initialization.");
            // Try to force memory initialization by allocating a small buffer
            try {
                const testPtr = Module._malloc(8);
                if (testPtr) {
                    console.log("Memory initialization succeeded with test allocation");
                    Module._free(testPtr);
                    return true;
                }
            } catch (e) {
                console.error("Failed to initialize memory:", e);
            }
        }
        return false;
    };
    
    // Try to create the heap directly if it's not available
    if (!Module.HEAPU8 || !Module.HEAPU8.buffer) {
        createHeap();
    }
    
    // Wait for HEAPU8, with more diagnostic output
    const waitForMemory = async () => {
        const maxAttempts = 10;
        for (let attempts = 0; attempts < maxAttempts; attempts++) {
            if (Module.HEAPU8 && Module.HEAPU8.buffer) {
                console.log("WebAssembly memory is ready");
                return true;
            }
            
            console.log(`Waiting for HEAPU8... (attempt ${attempts+1}/${maxAttempts})`);
            console.log("Module keys:", Object.keys(Module).filter(k => !k.startsWith('_')).join(', '));
            
            // Try to create the heap if not already done
            createHeap();
            
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        // If still not available, try to proceed anyway with a workaround
        if (!Module.HEAPU8 || !Module.HEAPU8.buffer) {
            console.warn("Failed to get WebAssembly memory. Attempting to create a fallback...");
            
            // Create a minimal buffer as a fallback (this is a last resort)
            try {
                if (!Module.HEAPU8) {
                    Module.HEAPU8 = new Uint8Array(1024 * 1024); // 1MB buffer as fallback
                    console.log("Created fallback memory buffer");
                }
                return true;
            } catch (e) {
                console.error("Failed to create fallback memory:", e);
                return false;
            }
        }
        
        return false;
    };
    
    await waitForMemory();
    
    // If audio has been requested to start but was waiting for initialization
    if (audioContext !== null && audioContext.state === "running") {
        await setupAudioWorklet();
    }
};

// Audio buffer and pointer
let dataPtr = null;
let data = new Float32Array();

// Setup the audio worklet
async function setupAudioWorklet() {
    // Create a new buffer for audio processing if needed
    if (dataPtr === null) {
        try {
            // Use a reasonable default buffer size
            const bufferSize = 1024;
            data = new Float32Array(bufferSize * 2); // stereo
            
            // Make sure Module.HEAPU8 exists and has a buffer
            if (!Module.HEAPU8 || !Module.HEAPU8.buffer) {
                console.error("WebAssembly memory not initialized for setupAudioWorklet");
                
                // Try to manually set up the heap if possible
                if (!Module.HEAPU8 && typeof Module.wasmMemory === 'object' && Module.wasmMemory.buffer) {
                    console.log("Creating HEAPU8 from wasmMemory.buffer");
                    Module.HEAPU8 = new Uint8Array(Module.wasmMemory.buffer);
                } else {
                    console.error("Cannot create memory. Retrying in 500ms...");
                    return new Promise(resolve => {
                        setTimeout(async () => {
                            await setupAudioWorklet();
                            resolve();
                        }, 500);
                    });
                }
            }
            
            // Allocate memory in Emscripten heap
            const nDataBytes = data.length * data.BYTES_PER_ELEMENT;
            dataPtr = Module._malloc(nDataBytes);
            
            if (!dataPtr) {
                throw new Error("Failed to allocate memory with Module._malloc");
            }
            
            console.log("Successfully allocated audio buffer in WASM memory at address", dataPtr);
        
            // Copy initial data to the heap (zeros)
            const dataHeap = new Uint8Array(Module.HEAPU8.buffer, dataPtr, nDataBytes);
            dataHeap.set(new Uint8Array(data.buffer));
        } catch (error) {
            console.error("Error allocating audio buffer:", error);
            return;
        }
    }
    
    try {
        // Add the audio processor module (using full path for reliability)
        const audioProcessorUrl = new URL('emscripten/audio-processor.js', window.location.href).href;
        await audioContext.audioWorklet.addModule(audioProcessorUrl);
        
        // Create an AudioWorkletNode
        audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2], // stereo output
            processorOptions: {
                bufferSize: data.length / 2 // Number of frames (not channels)
            }
        });
        
        // Set up communication with the audio processor
        audioWorkletNode.port.onmessage = handleWorkletMessage;
        
        // Send initial setup to the worklet - need to send a proper structured clone of the memory
        try {
            // We need to send the pointer and the memory buffer separately
            audioWorkletNode.port.postMessage({
                type: 'init',
                dataPtr: dataPtr
            });
            
            // The AudioWorklet can't directly use the Module.HEAPU8 reference, so we send the raw values
            // it needs to reconstruct a Float32Array view of the memory
            const memoryInfo = {
                type: 'memoryBuffer',
                byteOffset: dataPtr,
                length: data.length
            };
            
            // Try to transfer a minimal portion of the memory instead of the full buffer
            const minBuffer = new ArrayBuffer(data.length * 4); // 4 bytes per float
            audioWorkletNode.port.postMessage(memoryInfo);
            
            console.log("Successfully sent memory setup to AudioWorklet");
        } catch (e) {
            console.error("Error sending data to AudioWorklet:", e);
        }
        
        // Connect the node to the audio output
        audioWorkletNode.connect(audioContext.destination);
        
    } catch (error) {
        console.error("Error setting up AudioWorklet:", error);
    }
}

// Handle messages from the audio worklet processor
function handleWorkletMessage(event) {
    if (event.data.type === 'audioNeeded') {
        // Process more audio data
        const frameSize = event.data.frameSize;
        
        if (getSamples !== null && dataPtr !== null && Module.HEAPU8 && Module.HEAPU8.buffer) {
            try {
                // Call the C++ function to fill the buffer
                getSamples(dataPtr, frameSize, 2);
                
                // Generate a test tone if needed (uncomment to test basic audio output)
                // const testData = new Float32Array(frameSize * 2);
                // for (let i = 0; i < frameSize; i++) {
                //     const value = Math.sin(i * 0.1) * 0.5;
                //     testData[i*2] = value;
                //     testData[i*2+1] = value;
                // }
                
                // Get a view of the data and send it to the AudioProcessor
                const result = new Float32Array(Module.HEAPU8.buffer, dataPtr, frameSize * 2);
                
                // Debug: Check if we're getting non-zero audio data
                let hasSound = false;
                let sum = 0;
                for (let i = 0; i < result.length; i++) {
                    sum += Math.abs(result[i]);
                    if (Math.abs(result[i]) > 0.0001) {
                        hasSound = true;
                    }
                }
                
                if (!hasSound) {
                    console.log("Warning: Audio buffer contains only silence, sum:", sum);
                    
                    // Fill with a simple sine tone for testing audio path
                    for (let i = 0; i < frameSize; i++) {
                        const value = Math.sin(i * 0.1) * 0.2;
                        result[i*2] = value;
                        result[i*2+1] = value;
                    }
                    console.log("Inserted test tone");
                }
                
                // Create a copy of the data to send to the AudioProcessor
                const audioCopy = new Float32Array(frameSize * 2);
                audioCopy.set(result);
                
                // Send the copied data to the AudioProcessor
                audioWorkletNode.port.postMessage({
                    type: 'audioData',
                    audio: audioCopy
                });
                
            } catch (e) {
                console.error("Error processing audio:", e);
            }
        } else {
            console.warn("Cannot process audio - missing required components");
        }
    } else if (event.data.type === 'requestSetup' || event.data.type === 'requestMemory') {
        // AudioProcessor is requesting setup information
        console.log("AudioProcessor requesting setup");
        
        try {
            // Send basic setup again
            audioWorkletNode.port.postMessage({
                type: 'init',
                dataPtr: dataPtr
            });
            
            // Send memory info
            const memoryInfo = {
                type: 'memoryBuffer',
                byteOffset: dataPtr,
                length: data.length
            };
            audioWorkletNode.port.postMessage(memoryInfo);
            
        } catch (e) {
            console.error("Error sending setup to AudioProcessor:", e);
        }
    } else if (event.data.type === 'initialized') {
        console.log("AudioWorklet processor initialized successfully");
    }
}

// Audio state tracking
let audioRunning = false;

// Start audio playback
async function startAudio() {
    if (audioRunning) return;
    
    // Create AudioContext if it doesn't exist
    if (!audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            alert("Sorry, but the Web Audio API is not supported by your browser. Please consider upgrading to the latest version or using Google Chrome or Mozilla Firefox");
            return;
        }
        audioContext = new AudioContext();
    }
    
    // Resume the audio context (required by browsers for autoplay policies)
    await audioContext.resume();
    
    // Don't proceed until Emscripten runtime is initialized
    if (getSamples === null) {
        console.log("WebAssembly runtime not initialized yet, waiting...");
        setTimeout(startAudio, 300); // Try again in 300ms
        return;
    }
    
    // Also ensure WebAssembly memory is available
    if (!Module.HEAPU8 || !Module.HEAPU8.buffer) {
        console.log("WebAssembly memory not ready yet, waiting...");
        
        // Try to explicitly request memory initialization if possible
        if (typeof Module._ensureInitRuntime === 'function') {
            try {
                console.log("Explicitly calling _ensureInitRuntime...");
                Module._ensureInitRuntime();
            } catch (e) {
                console.warn("Error calling _ensureInitRuntime:", e);
            }
        }
        
        setTimeout(startAudio, 300); // Try again in 300ms
        return;
    }
    
    // Setup the AudioWorklet if not already done
    if (!audioWorkletNode) {
        await setupAudioWorklet();
    } else {
        // Make sure it's connected to the destination
        try {
            audioWorkletNode.disconnect();  // First disconnect in case already connected
            audioWorkletNode.connect(audioContext.destination);
            console.log("Reconnected audio node to destination");
        } catch (e) {
            console.error("Error connecting audio node:", e);
        }
    }
    
    // Explicitly trigger audio processing
    if (getSamples && dataPtr && Module.HEAPU8 && Module.HEAPU8.buffer) {
        const frameSize = 1024;
        getSamples(dataPtr, frameSize, 2);
        console.log("Manually triggered first audio frame");
    }
    
    audioRunning = true;
    document.getElementById("startStop").innerHTML = "stop &#x23F9;";
    document.getElementById("startStop").href = "javascript: stopAudio();";
}

// Stop audio playback
async function stopAudio() {
    audioRunning = false;
    
    if (audioContext) {
        await audioContext.suspend();
    }
    
    // Disconnect the node if it exists
    if (audioWorkletNode) {
        try {
            audioWorkletNode.disconnect();
            console.log("Disconnected audio node");
        } catch (e) {
            console.error("Error disconnecting audio node:", e);
        }
    }
    
    document.getElementById("startStop").innerHTML = "start &#x25b6;";
    document.getElementById("startStop").href = "javascript: startAudio();";
}

// Clean up and free memory when the page is unloaded
window.addEventListener('beforeunload', function() {
    if (dataPtr !== null) {
        Module._free(dataPtr);
    }
});
