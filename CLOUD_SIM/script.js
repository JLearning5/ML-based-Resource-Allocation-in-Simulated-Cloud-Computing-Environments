
    // Configuration Constants
    const CONFIG = {
        HOST_COUNT: 5,
        HOST_SPACING: 12,
        HOST_BASE_COLOR: 0x00aa00,
        HOST_HIGH_LOAD_COLOR: 0xff0000,
        VM_ENTRY_COUNT: 8,
        VM_ENTRY_X_SPACING: 8,
        VM_ENTRY_Z: -25,
        VM_COLOR_PLACEMENT: 0x0000ff,
        VM_COLOR_REMOVAL_EVENT: 0xff0000, // Not currently used visually, but defined
        CABLE_COLOR: 0x888888,
        ANIMATION_SCALE_DURATION: 0.5,
        DEFAULT_TIMESCALE: 1,
        MAX_TIMESCALE: 10,
        MIN_TIMESCALE: 0.1,
        JSON_PATH: './ml_rasc/improved_cloud_allocation_metrics.json' // ENSURE THIS PATH IS CORRECT
    };

    // --- Core Three.js Setup ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeeeeee);
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 30, 50);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    // --- Lighting ---
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(15, 30, 20);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    // --- Ground ---
    const groundGeo = new THREE.PlaneGeometry(100, 100);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // --- Object Groups ---
    const hostGroup = new THREE.Group();
    const vmGroup = new THREE.Group();    // Only holds VISUAL VMs
    const cableGroup = new THREE.Group(); // Only holds VISUAL cables
    scene.add(hostGroup);
    scene.add(vmGroup);
    scene.add(cableGroup);

    // --- Application State ---
    const hosts = []; // Array holding host mesh references
    const infoEl = document.getElementById('info');
    const detailsEl = document.getElementById('details');
    let events = []; // Stores loaded event data
    let simulationTime = 0;
    let nextEventIndex = 0;
    let timeScale = CONFIG.DEFAULT_TIMESCALE;
    let isPlaying = false;
    let maxVMId = 0; // Max VM ID encountered in data
    let maxVisibleVMs = Infinity; // Max VMs to show visually (Infinity = no limit)
    const clock = new THREE.Clock();
    const activeVMs = new Map(); // Holds ALL active VMs (visual or logical), VM_ID -> VMData
    let selectedObject = null; // Holds the currently selected Host Mesh or VM Group
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // --- GUI Setup ---
    const guiParams = {
      TimeScale: timeScale,
      MaxSeenVMId: 0,
      MaxVisibleVMs: 100, // Initial GUI value (100 representing unlimited here)
      Play: startReplay,
      Pause: pauseReplay,
      Reset: resetReplay
    };
    const gui = new dat.GUI();
    gui.add(guiParams, 'TimeScale', CONFIG.MIN_TIMESCALE, CONFIG.MAX_TIMESCALE).name('Replay Speed').onChange(v => timeScale = v);
    gui.add(guiParams, 'MaxSeenVMId').name('Max VM ID Seen').listen(); // Display only
    gui.add(guiParams, 'MaxVisibleVMs', 1, 100).step(1).name('Max Visible VMs').onChange(v => {
        // Assuming slider max value (100 here) means "unlimited"
        maxVisibleVMs = (v === 100) ? Infinity : v;
        console.log("Max visible VMs set to:", maxVisibleVMs);
    }).listen();
    gui.add(guiParams, 'Play');
    gui.add(guiParams, 'Pause');
    gui.add(guiParams, 'Reset');

    // Initialize maxVisibleVMs based on GUI starting value
     maxVisibleVMs = (guiParams.MaxVisibleVMs === 100) ? Infinity : guiParams.MaxVisibleVMs;

    // --- Host Functions ---
    function updateHostVisual(host) { // Only updates color now
        const { currentCPU, totalCPU } = host.userData;
        const load = totalCPU > 0 ? Math.min(currentCPU / totalCPU, 1.0) : 0;
        const baseColor = new THREE.Color(CONFIG.HOST_BASE_COLOR);
        const highLoadColor = new THREE.Color(CONFIG.HOST_HIGH_LOAD_COLOR);
        if (host.material && host.material.color && selectedObject !== host) {
            host.material.color.lerpColors(baseColor, highLoadColor, load);
        } else if (!host.material?.color) {
             console.warn("Host mesh material or color missing:", host);
        }
    }

    function createHosts() {
      hosts.length = 0;
      hostGroup.children.length = 0;
      for (let i = 0; i < CONFIG.HOST_COUNT; i++) {
        const geo = new THREE.BoxGeometry(6, 3, 6);
        const mat = new THREE.MeshStandardMaterial({ color: CONFIG.HOST_BASE_COLOR, roughness: 0.6, metalness: 0.2 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set((i - (CONFIG.HOST_COUNT - 1) / 2) * CONFIG.HOST_SPACING, 1.5, 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = {
            type: 'Host', id: i,
            totalCPU: 100, totalRAM: 100,
            currentCPU: 0, currentRAM: 0
        };
        hostGroup.add(mesh);
        hosts.push(mesh);
        updateHostVisual(mesh);
      }
    }

    // --- VM Related ---
    const entryPoints = Array.from({ length: CONFIG.VM_ENTRY_COUNT }, (_, i) =>
      new THREE.Vector3((i - (CONFIG.VM_ENTRY_COUNT - 1) / 2) * CONFIG.VM_ENTRY_X_SPACING, 2, CONFIG.VM_ENTRY_Z)
    );

    function createVMShape(color, size) { // Creates the 3D representation
      const g = new THREE.Group();
      const towerGeo = new THREE.BoxGeometry(size, size * 0.6, size * 0.4);
      const towerMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.7 });
      const tower = new THREE.Mesh(towerGeo, towerMat);
      tower.position.y = size * 0.3;
      tower.castShadow = true;
      tower.userData.part = 'tower';
      const screenGeo = new THREE.BoxGeometry(size * 0.8, size * 0.4, 0.1);
      const screenMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 });
      const screen = new THREE.Mesh(screenGeo, screenMat);
      screen.position.set(0, size * 0.6, size * 0.2 + 0.05);
      screen.castShadow = true;
      screen.userData.part = 'screen';
      g.add(tower);
      g.add(screen);
      return g;
    }

    function spawnVM(evt) { // Handles VM placement event
        infoEl.innerText = `Event ${evt.vm_id} @${evt.time.toFixed(2)}s`;
        detailsEl.innerHTML = Object.entries(evt)
          .map(([k,v]) => `<b>${k}</b>: ${v}`).join('<br/>');
        if (activeVMs.has(evt.vm_id)) {
            console.warn(`VM ${evt.vm_id} already exists. Skipping.`);
            return;
        }
        if (evt.host_id === undefined || evt.host_id < 0 || evt.host_id >= hosts.length) {
             console.warn(`Invalid host_id ${evt.host_id} for VM ${evt.vm_id}. Skipping.`);
             return;
        }
        const host = hosts[evt.host_id];

        // Check if visualization limit is reached
        let currentVisibleVMCount = 0;
        activeVMs.forEach(vm => { if (vm.isVisual) currentVisibleVMCount++; });
        let canVisualize = currentVisibleVMCount < maxVisibleVMs;
        let vmMesh = null;
        let cableMesh = null;

        if (!canVisualize) {
            console.log(`Max visible VM limit (${maxVisibleVMs}) reached. VM ${evt.vm_id} placed logically only.`);
        }

        // Update Host Resources (Always)
        host.userData.currentCPU += (evt.required_cpu || 0);
        host.userData.currentRAM += (evt.required_ram || 0);
        updateHostVisual(host);

        // Create Visuals ONLY if allowed
        if (canVisualize) {
            const color = CONFIG.VM_COLOR_PLACEMENT;
            const size = 1 + Math.max(0, (evt.required_cpu || 10)) * 0.02;
            vmMesh = createVMShape(color, size);
            vmMesh.userData = { type: 'VM', vm_id: evt.vm_id, ...evt }; // Store data on the Group
            vmMesh.scale.set(0.1, 0.1, 0.1);
            const entryPoint = entryPoints[evt.vm_id % CONFIG.VM_ENTRY_COUNT];
            vmMesh.position.set(
                entryPoint.x + (Math.random() - 0.5) * 2, entryPoint.y, entryPoint.z + (Math.random() - 0.5) * 2
            );
            vmGroup.add(vmMesh); // Add to scene group

            const points = [vmMesh.position.clone(), host.position.clone().setY(1.5)];
            const cableGeo = new THREE.BufferGeometry().setFromPoints(points);
            const cableMat = new THREE.LineBasicMaterial({ color: CONFIG.CABLE_COLOR });
            cableMesh = new THREE.Line(cableGeo, cableMat);
            cableMesh.userData = { type: 'Cable', vm_id: evt.vm_id };
            cableGroup.add(cableMesh); // Add to scene group
        }

        // Store VM state in map (visual or logical)
        const vmData = {
            mesh: vmMesh, // null if not visual
            cable: cableMesh, // null if not visual
            isVisual: canVisualize,
            host_id: host.userData.id,
            required_cpu: (evt.required_cpu || 0),
            required_ram: (evt.required_ram || 0),
            isScalingIn: canVisualize, // Only animate if visual
            scaleStartTime: simulationTime,
            eventData: evt
        };
        activeVMs.set(evt.vm_id, vmData);
    }

    function removeVM(vmData) { // Handles VM removal (from map data)
        if (!vmData) return;
        const vm_id = vmData.eventData.vm_id;
        const host = hosts.find(h => h.userData.id === vmData.host_id);

        // Remove visuals ONLY if they existed
        if (vmData.isVisual) {
            if (vmData.mesh) vmGroup.remove(vmData.mesh);
            if (vmData.cable) cableGroup.remove(vmData.cable);
            if (selectedObject === vmData.mesh) { // Deselect if this visual object was selected
                selectedObject = null;
                detailsEl.innerText = 'Click on a Host or VM for details.';
            }
            // TODO: Consider geometry/material disposal for performance
        }

        // Update Host Resources (Always)
        if (host) {
            host.userData.currentCPU = Math.max(0, host.userData.currentCPU - vmData.required_cpu);
            host.userData.currentRAM = Math.max(0, host.userData.currentRAM - vmData.required_ram);
            updateHostVisual(host);
        } else {
             console.warn(`Host ${vmData.host_id} not found when removing VM ${vm_id}`);
        }

        // Remove from active map (Always)
        activeVMs.delete(vm_id);
    }


    // --- Event Processing & Playback ---
     function handleEvent(evt) { // Processes a single event
        // Update info panel (can be verbose)
        // infoEl.innerText = `Event: ${evt.event_type} VM ${evt.vm_id} @ ${simulationTime.toFixed(2)}s (Event Time: ${evt.time.toFixed(2)}s)`;

        if (evt.event_type === 'placement') {
            spawnVM(evt);
        } else if (evt.event_type === 'removal') {
            if (activeVMs.has(evt.vm_id)) {
                removeVM(activeVMs.get(evt.vm_id)); // Pass the data from the map
            } else {
                 // console.warn(`Removal event for VM ${evt.vm_id} which is not active.`);
            }
        }
    }

    function startReplay() {
      if (isPlaying) return;
      isPlaying = true;
      clock.start();
      infoEl.innerText = 'Replaying...';
    }

    function pauseReplay() {
      if (!isPlaying) return;
      isPlaying = false;
      clock.stop();
      infoEl.innerText = 'Paused';
    }

    function resetReplay() {
      pauseReplay();
      simulationTime = 0;
      nextEventIndex = 0;

      // Clear visual objects and the state map
      activeVMs.forEach(vmData => { // Use data from map to potentially remove visuals
          if (vmData.isVisual) {
              if(vmData.mesh) vmGroup.remove(vmData.mesh);
              if(vmData.cable) cableGroup.remove(vmData.cable);
          }
      });
      activeVMs.clear(); // Clear the state map

      // Reset hosts
      hosts.forEach(host => {
        host.userData.currentCPU = 0;
        host.userData.currentRAM = 0;
        updateHostVisual(host);
      });

      // Reset selection and details
      if (selectedObject){
          // Manually trigger deselection logic if something was selected
           const type = selectedObject.userData.type;
           if (type === 'Host') {
               if (selectedObject.userData.originalColor !== undefined) selectedObject.material.color.setHex(selectedObject.userData.originalColor);
               else updateHostVisual(selectedObject); // Reapply load color
               delete selectedObject.userData.originalColor;
           } else if (type === 'VM') {
               // Revert children colors
                selectedObject.children.forEach(child => {
                    if (child.material && child.userData.originalColor !== undefined) {
                         child.material.color.setHex(child.userData.originalColor);
                         delete child.userData.originalColor;
                    } else if (child.material) {
                         // Fallback to default color (simplified)
                         if (child.userData.part === 'screen') child.material.color.setHex(0x222222);
                         else child.material.color.setHex(CONFIG.VM_COLOR_PLACEMENT);
                    }
                });
           }
          selectedObject = null;
      }
      detailsEl.innerText = 'Click on a Host or VM for details.';

      // Update GUI display info
      guiParams.MaxSeenVMId = events.reduce((max, evt) => Math.max(max, evt.vm_id || 0), 0);
      infoEl.innerText = `Reset. Loaded ${events.length} events. Press Play.`;
    }

    // --- Loading Initial Data ---
    fetch(CONFIG.JSON_PATH)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}, check path: ${CONFIG.JSON_PATH}`);
        return response.json();
      })
      .then(data => {
          if (!Array.isArray(data)) throw new Error("Loaded data is not an array. Check JSON structure.");
          events = data.sort((a, b) => a.time - b.time); // Sort by time
          maxVMId = events.reduce((max, evt) => Math.max(max, evt.vm_id || 0), 0);
          guiParams.MaxSeenVMId = maxVMId; // Update GUI display
          infoEl.innerText = `Loaded ${events.length} events. Max VM ID: ${maxVMId}. Press Play.`;
          createHosts(); // Create hosts after config is known
          resetReplay(); // Set initial simulation state
      })
      .catch(e => {
          console.error('Failed to load or process events:', e);
          infoEl.innerText = `Error loading events: ${e.message}. Check console & path.`;
          detailsEl.innerHTML = `<b>Failed to load:</b> ${CONFIG.JSON_PATH}<br/>Ensure the file exists and is accessible. Check browser console (F12) for more details. If running locally, you might need a simple web server.`;
          // Disable GUI controls on error?
          // gui.__controllers.forEach(c => c.domElement.style.pointerEvents = 'none');
          // gui.domElement.style.opacity = 0.5;
      });


    // --- Interaction ---
    function displayObjectDetails(data) { // Renders data to the details div
        const detailsToShow = { ...data };
        delete detailsToShow.originalColor; // Internal state
        // delete detailsToShow.eventData; // Optionally hide raw event

        let detailsHTML = `<b>Type:</b> ${detailsToShow.type || 'N/A'}<br/>`;
        if (detailsToShow.type === 'Host') {
             const cpuLoad = detailsToShow.totalCPU > 0 ? (detailsToShow.currentCPU / detailsToShow.totalCPU * 100).toFixed(0) : 0;
             const ramLoad = detailsToShow.totalRAM > 0 ? (detailsToShow.currentRAM / detailsToShow.totalRAM * 100).toFixed(0) : 0;
             detailsHTML += `<b>CPU Load:</b> ${cpuLoad}% (${detailsToShow.currentCPU.toFixed(0)}/${detailsToShow.totalCPU})<br/>`; // Show raw too
             detailsHTML += `<b>RAM Load:</b> ${ramLoad}% (${detailsToShow.currentRAM.toFixed(0)}/${detailsToShow.totalRAM})<br/>`;
        }

        detailsHTML += Object.entries(detailsToShow)
            // Filter out keys already handled or we don't want to show
            .filter(([key]) => key !== 'type' && !(detailsToShow.type === 'Host' && ['currentCPU', 'totalCPU', 'currentRAM', 'totalRAM'].includes(key)) )
            .map(([key, value]) => {
                let displayValue = value;
                if (key === 'eventData' && typeof value === 'object' && value !== null) {
                     displayValue = '{...}'; // Summarize event data
                } else if (typeof value === 'number') {
                    displayValue = value.toFixed(2);
                } else if (typeof value === 'object' && value !== null) {
                    displayValue = JSON.stringify(value);
                    if (displayValue.length > 100) displayValue = displayValue.substring(0, 100) + '...';
                } else if (value === null) {
                    displayValue = 'null';
                } else if (value === undefined) {
                    displayValue = 'undefined';
                }
                // Simple key formatting
                const displayKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                return `<b>${displayKey}</b>: ${displayValue}`;
            })
            .join('<br/>');
        detailsEl.innerHTML = detailsHTML;
    }

    function onDocumentMouseDown(event) { // Handles clicks for selection
        event.preventDefault();
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = - (event.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);

        let previouslySelected = selectedObject;
        let clickTargetFound = false;

        // --- Deselect Previous Object ---
        if (selectedObject) {
            const type = selectedObject.userData.type;
             if (type === 'Host') {
                 if (selectedObject.userData.originalColor !== undefined) selectedObject.material.color.setHex(selectedObject.userData.originalColor);
                 else updateHostVisual(selectedObject); // Reapply load color
                 delete selectedObject.userData.originalColor;
             } else if (type === 'VM') { // VM Group was selected
                 selectedObject.children.forEach(child => { // Revert children
                     if (child.material && child.userData.originalColor !== undefined) {
                          child.material.color.setHex(child.userData.originalColor);
                          delete child.userData.originalColor;
                     } else if (child.material) { // Fallback
                          if (child.userData.part === 'screen') child.material.color.setHex(0x222222);
                          else child.material.color.setHex(CONFIG.VM_COLOR_PLACEMENT);
                     }
                 });
             }
            selectedObject = null;
        }

        // --- Check for New Intersections ---
        const intersectsHosts = raycaster.intersectObjects(hostGroup.children, false);
        const intersectsVMs = raycaster.intersectObjects(vmGroup.children, true); // Intersect visual VMs

        if (intersectsHosts.length > 0) {
            const intersectedHost = intersectsHosts[0].object;
            if (intersectedHost.userData.type === 'Host') {
                 clickTargetFound = true;
                 if (previouslySelected !== intersectedHost) { // Don't re-highlight if clicking same
                     selectedObject = intersectedHost;
                     selectedObject.userData.originalColor = selectedObject.material.color.getHex();
                     selectedObject.material.color.setHex(0xffff00); // Host highlight
                 }
                 displayObjectDetails(intersectedHost.userData); // Always show details on click
            }
        } else if (intersectsVMs.length > 0) {
            let intersectedPart = intersectsVMs[0].object;
            let vmGroupObject = intersectedPart;
            while (vmGroupObject.parent && vmGroupObject.parent !== vmGroup) {
                vmGroupObject = vmGroupObject.parent;
            }
            if (vmGroupObject.userData && vmGroupObject.userData.type === 'VM') {
                clickTargetFound = true;
                 if (previouslySelected !== vmGroupObject) { // Don't re-highlight if clicking same
                    selectedObject = vmGroupObject; // Select the Group
                    selectedObject.children.forEach(child => { // Highlight children
                        if (child.material && child.material.color) {
                            child.userData.originalColor = child.material.color.getHex();
                            child.material.color.setHex(0xffaa00); // VM highlight
                        }
                    });
                 }
                displayObjectDetails(vmGroupObject.userData); // Always show details
            }
        }

        // Reset Details if Click Missed or re-clicked same object (which deselects it)
        if (!clickTargetFound || !selectedObject) {
             detailsEl.innerText = 'Click on a Host or VM for details.';
        }
    }
    document.addEventListener('mousedown', onDocumentMouseDown, false);


    // --- Animation Loop ---
    function animate() {
      requestAnimationFrame(animate);
      const deltaTime = clock.getDelta();

      if (isPlaying && events.length > 0) {
        simulationTime += deltaTime * timeScale;

        // Process events due by current simulation time
        while (nextEventIndex < events.length && events[nextEventIndex].time <= simulationTime) {
          handleEvent(events[nextEventIndex]);
          nextEventIndex++;
        }

        // Update active visual elements
        const currentTime = simulationTime;
        activeVMs.forEach((vmData) => {
            if (vmData.isVisual && vmData.mesh) { // Only process visual VMs
                 // Scale-in animation
                if (vmData.isScalingIn) {
                    const elapsed = currentTime - vmData.scaleStartTime;
                    const progress = Math.min(elapsed / CONFIG.ANIMATION_SCALE_DURATION, 1.0);
                    const scale = 0.1 + progress * 0.9;
                    vmData.mesh.scale.set(scale, scale, scale);
                    if (progress >= 1.0) vmData.isScalingIn = false;
                }
                // Cable update logic would go here if needed
            }
        });
      } // End if(isPlaying)

      controls.update(); // Required if enableDamping is true
      renderer.render(scene, camera);
    }

    // --- Resize Handler ---
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // --- Start ---
    animate(); // Start the animation loop
