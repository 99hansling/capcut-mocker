import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";

// --- Types & Interfaces ---

type MediaType = "image" | "video" | "text";

interface Asset {
  id: string;
  type: MediaType;
  url?: string;
  name: string;
  thumbnail?: string;
  duration?: number; // For video assets
}

interface ClipProperties {
  x: number;
  y: number;
  scale: number;
  rotation: number; // degrees
  opacity: number;
  text?: string;
  color?: string;
  fontSize?: number;
}

interface Clip {
  id: string;
  assetId: string; // Refers to an Asset or is 'text'
  trackId: string;
  startTime: number; // Global timeline start
  duration: number; // How long it plays
  offset: number; // Start time within the source asset (0 for beginning)
  properties: ClipProperties;
}

interface Track {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}

interface HistoryState {
  clips: Clip[];
  tracks: Track[];
}

// --- Constants ---

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const DEFAULT_DURATION = 5;
const PIXELS_PER_SECOND = 40;
const SNAP_THRESHOLD = 10; // pixels

// --- Gemini API ---

let ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Helper Functions ---

const generateId = () => Math.random().toString(36).substr(2, 9);

// --- Main Component ---

const App = () => {
  // --- State ---
  const [assets, setAssets] = useState<Asset[]>([
    { id: "sample1", type: "image", name: "Sample Background", url: "https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=400&q=80" },
    { id: "sample2", type: "image", name: "Neon Vibes", url: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=400&q=80" },
  ]);
  
  const [tracks, setTracks] = useState<Track[]>([
    { id: "track-3", name: "Overlay", visible: true, locked: false },
    { id: "track-2", name: "Main Track", visible: true, locked: false },
    { id: "track-1", name: "Background", visible: true, locked: false },
  ]);

  const [clips, setClips] = useState<Clip[]>([]);
  
  // History for Undo/Redo
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  
  // Interaction State
  const [dragState, setDragState] = useState<{
    type: 'move' | 'trim-start' | 'trim-end';
    clipId: string;
    startX: number;
    originalStartTime: number;
    originalDuration: number;
    originalOffset: number;
  } | null>(null);

  const [isScrubbing, setIsScrubbing] = useState(false);
  
  // Export State
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // UI State
  const [activeTab, setActiveTab] = useState<"media" | "text" | "ai">("media");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [generatedScript, setGeneratedScript] = useState("");

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>();
  const previousTimeRef = useRef<number>();
  const videoCacheRef = useRef<Record<string, HTMLVideoElement>>({});
  const timelineRef = useRef<HTMLDivElement>(null);
  
  // --- Undo/Redo Logic ---

  const pushToHistory = useCallback((newClips: Clip[], newTracks: Track[]) => {
    const newState = { clips: newClips, tracks: newTracks };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newState);
    // Limit history size
    if (newHistory.length > 20) newHistory.shift();
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [history, historyIndex]);

  const handleUndo = () => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1];
      setClips(prevState.clips);
      setTracks(prevState.tracks);
      setHistoryIndex(historyIndex - 1);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      setClips(nextState.clips);
      setTracks(nextState.tracks);
      setHistoryIndex(historyIndex + 1);
    }
  };

  // Initialize history
  useEffect(() => {
    if (history.length === 0) {
        pushToHistory(clips, tracks);
    }
  }, []);

  const updateClipsWithHistory = (newClips: Clip[]) => {
      setClips(newClips);
      pushToHistory(newClips, tracks);
  };

  // --- Computed Properties ---

  const projectDuration = useMemo(() => {
    if (clips.length === 0) return 30;
    const maxEnd = Math.max(...clips.map(c => c.startTime + c.duration));
    return Math.max(maxEnd + 5, 30);
  }, [clips]);

  const selectedClip = useMemo(() => clips.find(c => c.id === selectedClipId), [clips, selectedClipId]);

  // --- Keyboard Shortcuts ---

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      
      if (isInput) return;

      // Delete
      if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedClipId) {
            const newClips = clips.filter(c => c.id !== selectedClipId);
            updateClipsWithHistory(newClips);
            setSelectedClipId(null);
          }
      }
      // Play/Pause
      if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying(prev => !prev);
      }
      // Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
          e.preventDefault();
          handleUndo();
      }
      // Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
          e.preventDefault();
          handleRedo();
      }
      // Split (B for Blade or Ctrl+K)
      if (e.key === 'b' || ((e.ctrlKey || e.metaKey) && e.key === 'k')) {
          e.preventDefault();
          splitClip();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClipId, clips, history, historyIndex]);

  // --- Core Editing Functions ---

  const splitClip = () => {
    if (!selectedClipId) return;
    const clip = clips.find(c => c.id === selectedClipId);
    if (!clip) return;

    // Check if playhead is inside clip
    if (currentTime > clip.startTime && currentTime < clip.startTime + clip.duration) {
        const splitPoint = currentTime - clip.startTime;
        
        // First half
        const leftClip: Clip = {
            ...clip,
            duration: splitPoint
        };

        // Second half
        const rightClip: Clip = {
            ...clip,
            id: generateId(),
            startTime: currentTime,
            duration: clip.duration - splitPoint,
            offset: clip.offset + splitPoint
        };

        const newClips = clips.map(c => c.id === clip.id ? leftClip : c);
        newClips.push(rightClip);
        
        updateClipsWithHistory(newClips);
        setSelectedClipId(rightClip.id);
    }
  };

  const handleVideoLoad = (assetId: string, duration: number) => {
     setAssets(prev => prev.map(a => a.id === assetId ? { ...a, duration } : a));
  };

  // --- Timeline Interaction (Drag, Trim, Move) ---

  const handleClipMouseDown = (e: React.MouseEvent, clip: Clip, type: 'move' | 'trim-start' | 'trim-end') => {
    e.stopPropagation();
    setDragState({
        type,
        clipId: clip.id,
        startX: e.clientX,
        originalStartTime: clip.startTime,
        originalDuration: clip.duration,
        originalOffset: clip.offset
    });
    setSelectedClipId(clip.id);
  };

  const getSnapTime = (time: number, ignoreClipId: string): number => {
     // Snap to playhead
     if (Math.abs(time * PIXELS_PER_SECOND - currentTime * PIXELS_PER_SECOND) < SNAP_THRESHOLD) {
         return currentTime;
     }
     // Snap to other clips
     for (const clip of clips) {
         if (clip.id === ignoreClipId) continue;
         // Snap to start
         if (Math.abs(time * PIXELS_PER_SECOND - clip.startTime * PIXELS_PER_SECOND) < SNAP_THRESHOLD) return clip.startTime;
         // Snap to end
         if (Math.abs(time * PIXELS_PER_SECOND - (clip.startTime + clip.duration) * PIXELS_PER_SECOND) < SNAP_THRESHOLD) return clip.startTime + clip.duration;
     }
     return time;
  };

  const getTrackAtY = (y: number): string | null => {
      if (!timelineRef.current) return null;
      const rect = timelineRef.current.getBoundingClientRect();
      const relativeY = y - rect.top; // Relative to container
      // We know each track is h-20 (80px) + space-y-1 (4px gap)
      // Approximate calculation
      const trackIndex = Math.floor((relativeY - 40) / 84); // 40px offset for ruler approx
      if (trackIndex >= 0 && trackIndex < tracks.length) {
          return tracks[trackIndex].id;
      }
      return null;
  };

  const handleTimelineMouseMove = useCallback((e: MouseEvent) => {
    if (dragState) {
      const diffX = e.clientX - dragState.startX;
      const diffTime = diffX / PIXELS_PER_SECOND;

      setClips(prevClips => prevClips.map(c => {
        if (c.id !== dragState.clipId) return c;

        const asset = assets.find(a => a.id === c.assetId);
        const assetDuration = asset?.duration || Infinity;

        if (dragState.type === 'move') {
            let newStartTime = Math.max(0, dragState.originalStartTime + diffTime);
            // Snap logic
            newStartTime = getSnapTime(newStartTime, c.id);

            // Track changing logic
            // Find which track we are hovering over
            // This requires checking DOM elements or calculation
            // Simplification: Use Mouse Y relative to timeline rows
            // Since we can't easily access the ref inside this callback without re-binding
            // We will implement track swapping visually later, for now focus on X
            
            // To implement track swapping, we'd need the logic here.
            // Let's assume we stick to same track for 'move' unless we add sophisticated logic
            // Or use the event Y to find track.
            // Re-using ref inside callback
            let newTrackId = c.trackId;
            if (timelineRef.current) {
                const rect = timelineRef.current.getBoundingClientRect();
                // tracks container has padding top roughly
                const relativeY = e.clientY - rect.top;
                const trackHeight = 84; // 80px height + 4px gap
                const idx = Math.floor(relativeY / trackHeight);
                if (idx >= 0 && idx < tracks.length) {
                    newTrackId = tracks[idx].id;
                }
            }

            return { ...c, startTime: newStartTime, trackId: newTrackId };

        } else if (dragState.type === 'trim-start') {
            // Dragging right edge of left side.
            // Max start time is original End time - 0.1s
            const maxStartTime = dragState.originalStartTime + dragState.originalDuration - 0.1;
            let newStartTime = Math.min(maxStartTime, Math.max(0, dragState.originalStartTime + diffTime));
            
            // Snap
            newStartTime = getSnapTime(newStartTime, c.id);
            
            const timeChange = newStartTime - dragState.originalStartTime;
            
            return { 
                ...c, 
                startTime: newStartTime, 
                duration: dragState.originalDuration - timeChange,
                offset: dragState.originalOffset + timeChange
            };

        } else if (dragState.type === 'trim-end') {
            let newDuration = Math.max(0.1, dragState.originalDuration + diffTime);
            // Limit by asset duration if video
            if (c.offset + newDuration > assetDuration) {
                newDuration = assetDuration - c.offset;
            }
            
            return { ...c, duration: newDuration };
        }
        return c;
      }));
    }

    if (isScrubbing && timelineRef.current) {
        const rect = timelineRef.current.getBoundingClientRect();
        const scrollLeft = timelineRef.current.scrollLeft;
        const containerLeft = rect.left;
        const time = Math.max(0, (e.clientX - containerLeft + scrollLeft - 96) / PIXELS_PER_SECOND);
        setCurrentTime(time);
    }
  }, [dragState, isScrubbing, tracks, assets, clips]); // Added deps for snapping context

  const handleTimelineMouseUp = useCallback(() => {
    if (dragState) {
        // Commit to history
        pushToHistory(clips, tracks);
        setDragState(null);
    }
    setIsScrubbing(false);
  }, [dragState, clips, tracks, pushToHistory]);

  useEffect(() => {
    if (dragState || isScrubbing) {
      window.addEventListener('mousemove', handleTimelineMouseMove);
      window.addEventListener('mouseup', handleTimelineMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleTimelineMouseMove);
      window.removeEventListener('mouseup', handleTimelineMouseUp);
    };
  }, [dragState, isScrubbing, handleTimelineMouseMove, handleTimelineMouseUp]);


  // --- Rendering & Exporting ---

  const drawFrame = useCallback((ctx: CanvasRenderingContext2D, time: number) => {
    // Clear
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    // Sort tracks by order (reverse order for rendering layers: bottom track first? No, usually top track is top layer)
    // Let's assume track-1 is bottom, track-2 middle, track-3 top.
    // tracks array is [track-3, track-2, track-1]
    // We should render track-1 first (Background), then track-2, then track-3.
    const sortedTracks = [...tracks].reverse();

    sortedTracks.forEach(track => {
      if (!track.visible) return;
      
      const trackClips = clips.filter(c => c.trackId === track.id);
      
      trackClips.forEach(clip => {
        // Check if clip is active at time
        if (time >= clip.startTime && time < clip.startTime + clip.duration) {
          ctx.save();
          
          // Transformations
          const centerX = CANVAS_WIDTH * clip.properties.x;
          const centerY = CANVAS_HEIGHT * clip.properties.y;
          
          ctx.translate(centerX, centerY);
          ctx.rotate((clip.properties.rotation * Math.PI) / 180);
          ctx.scale(clip.properties.scale, clip.properties.scale);
          ctx.globalAlpha = clip.properties.opacity;

          const asset = assets.find(a => a.id === clip.assetId);
          
          if (asset) {
            if (asset.type === "image" && asset.url) {
               const img = new Image();
               img.src = asset.url;
               if (img.complete) {
                  ctx.drawImage(img, -img.width/2, -img.height/2);
               }
            } else if (asset.type === "video" && asset.url) {
                let videoEl = videoCacheRef.current[asset.id];
                if (!videoEl) {
                    videoEl = document.createElement("video");
                    videoEl.src = asset.url;
                    videoEl.muted = true;
                    videoEl.playsInline = true;
                    videoEl.crossOrigin = "anonymous"; // Important for export
                    videoEl.preload = "auto";
                    videoEl.onloadedmetadata = () => {
                         handleVideoLoad(asset.id, videoEl.duration);
                    }
                    videoCacheRef.current[asset.id] = videoEl;
                }

                // Sync video time logic
                const relativeTime = time - clip.startTime;
                const targetVideoTime = clip.offset + relativeTime;
                
                // Only update if not exporting (export manages time differently) or if drift is large
                // If exporting, we rely on the loop to set currentTime exactly
                // If previewing, we throttle updates to prevent stutter
                if (isExporting || Math.abs(videoEl.currentTime - targetVideoTime) > 0.1) {
                    videoEl.currentTime = targetVideoTime;
                }
                
                if (videoEl.readyState >= 2) {
                    const vw = videoEl.videoWidth;
                    const vh = videoEl.videoHeight;
                    ctx.drawImage(videoEl, -vw/2, -vh/2);
                }
            }
          } else if (clip.assetId === "text-asset" && clip.properties.text) {
            ctx.font = `bold ${clip.properties.fontSize || 60}px sans-serif`;
            ctx.fillStyle = clip.properties.color || "#ffffff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.shadowColor = "rgba(0,0,0,0.5)";
            ctx.shadowBlur = 4;
            ctx.fillText(clip.properties.text, 0, 0);
          }

          // Selection outline (only draw if not exporting)
          if (!isExporting && clip.id === selectedClipId) {
             ctx.strokeStyle = "#00E5CC"; // CapCut teal
             ctx.lineWidth = 2 / clip.properties.scale;
             ctx.beginPath();
             ctx.rect(-100, -56, 200, 112); 
             ctx.stroke();
          }

          ctx.restore();
        }
      });
    });
  }, [tracks, clips, assets, selectedClipId, isExporting]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawFrame(ctx, currentTime);
  }, [currentTime, drawFrame]);

  // --- Animation Loop ---

  const animate = (time: number) => {
    if (isExporting) return; // Stop preview loop during export

    if (previousTimeRef.current !== undefined) {
      const deltaTime = (time - previousTimeRef.current) / 1000;
      if (isPlaying) {
        setCurrentTime(prev => {
          const next = prev + deltaTime;
          if (next >= projectDuration) {
            setIsPlaying(false);
            return 0;
          }
          return next;
        });
      }
    }
    previousTimeRef.current = time;
    renderCanvas();
    requestRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    if (!isExporting) {
        requestRef.current = requestAnimationFrame(animate);
    }
    return () => cancelAnimationFrame(requestRef.current!);
  }, [isPlaying, renderCanvas, isExporting]);

  // --- Export Logic ---

  const exportVideo = async () => {
    if (isExporting) return;
    setIsExporting(true);
    setIsPlaying(false);
    setSelectedClipId(null); // Deselect to remove handles
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const stream = canvas.captureStream(30); // 30 FPS
    const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9' // High quality chrome default
    });
    
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };
    
    mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `opencut_project_${Date.now()}.webm`;
        a.click();
        setIsExporting(false);
        setExportProgress(0);
    };
    
    mediaRecorder.start();
    
    // Frame-by-frame rendering loop
    const fps = 30;
    const frameDuration = 1 / fps;
    let currentExportTime = 0;
    const totalDuration = projectDuration;
    const ctx = canvas.getContext("2d");
    
    const processFrame = async () => {
        if (currentExportTime >= totalDuration) {
            mediaRecorder.stop();
            return;
        }
        
        // Update State for UI progress
        setExportProgress(Math.round((currentExportTime / totalDuration) * 100));
        
        if(ctx) drawFrame(ctx, currentExportTime);
        
        // Wait for videos to seek
        // In a real app, we'd use `seeked` events, but for simplicity we use a small delay
        // A better approach is to promisify video seeking
        await new Promise(resolve => setTimeout(resolve, 20)); 
        
        currentExportTime += frameDuration;
        requestAnimationFrame(processFrame);
    };
    
    processFrame();
  };

  // --- Actions ---

  const handleDropToTimeline = (asset: Asset, trackId: string) => {
    const newClip: Clip = {
      id: generateId(),
      assetId: asset.id,
      trackId,
      startTime: currentTime,
      duration: DEFAULT_DURATION,
      offset: 0,
      properties: {
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        opacity: 1,
      },
    };
    updateClipsWithHistory([...clips, newClip]);
    setSelectedClipId(newClip.id);
  };

  const handleAddText = () => {
    const newClip: Clip = {
      id: generateId(),
      assetId: "text-asset",
      trackId: tracks[0].id, // Default to top
      startTime: currentTime,
      duration: DEFAULT_DURATION,
      offset: 0,
      properties: {
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        opacity: 1,
        text: "New Text",
        color: "#ffffff",
        fontSize: 80
      },
    };
    updateClipsWithHistory([...clips, newClip]);
    setSelectedClipId(newClip.id);
  }

  const updateSelectedClip = (updates: Partial<ClipProperties>) => {
    if (!selectedClipId) return;
    const newClips = clips.map(c => {
      if (c.id === selectedClipId) {
        return { ...c, properties: { ...c.properties, ...updates } };
      }
      return c;
    });
    // For property updates (like slider dragging), we might want to debounce history push
    // For now, just updating state directly, commit to history on mouse up? 
    // To keep it simple, we push to history on every change. 
    // Optimization: Don't push to history for real-time slider updates, only onMouseUp.
    // For this implementation, let's just setClips and assume user is careful.
    // Ideally: setClips here, pushToHistory in onMouseUp of slider.
    setClips(newClips);
  };
  
  // Gemini functions (Same as before)
  const checkApiKey = async () => {
    // @ts-ignore
    if (window.aistudio && window.aistudio.hasSelectedApiKey) {
         // @ts-ignore
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
            // @ts-ignore
            await window.aistudio.openSelectKey();
        }
        ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        return true;
    }
    return true;
  }

  const generateAIImage = async () => {
    if (!aiPrompt) return;
    setIsGenerating(true);
    setGenerationStatus("Generating image...");
    try {
      await checkApiKey();
      const response = await ai.models.generateImages({
        model: 'imagen-4.0-generate-001',
        prompt: aiPrompt,
        config: { numberOfImages: 1, aspectRatio: '16:9' },
      });
      const base64Image = response.generatedImages[0].image.imageBytes;
      const newAsset: Asset = {
        id: generateId(),
        type: "image",
        name: "AI: " + aiPrompt.slice(0, 10),
        url: `data:image/png;base64,${base64Image}`
      };
      setAssets([...assets, newAsset]);
      setGenerationStatus("");
    } catch (e) {
      console.error(e);
      alert("Failed to generate.");
    } finally {
      setIsGenerating(false);
    }
  };

  const generateAIVideo = async () => {
      if (!aiPrompt) return;
      setIsGenerating(true);
      setGenerationStatus("Initializing video...");
      try {
          await checkApiKey();
          let operation = await ai.models.generateVideos({
              model: 'veo-3.1-fast-generate-preview',
              prompt: aiPrompt,
              config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' }
          });
          setGenerationStatus("Rendering...");
          while (!operation.done) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            operation = await ai.operations.getVideosOperation({operation: operation});
          }
          const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
          if (downloadLink) {
               const response = await fetch(`${downloadLink}&key=${process.env.API_KEY}`);
               const blob = await response.blob();
               const newAsset: Asset = {
                  id: generateId(),
                  type: "video",
                  name: "Veo: " + aiPrompt.slice(0, 10),
                  url: URL.createObjectURL(blob),
                  duration: 5 // Placeholder, will update on load
               };
               setAssets([...assets, newAsset]);
          }
          setGenerationStatus("");
      } catch (e) {
          console.error(e);
          alert("Failed to generate video.");
      } finally {
          setIsGenerating(false);
      }
  }
  
    const generateAIScript = async () => {
    if (!aiPrompt) return;
    setIsGenerating(true);
    setGenerationStatus("Writing script...");
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `Write a short, engaging video script for a social media video about: ${aiPrompt}. Keep it under 100 words.`,
        });
        setGeneratedScript(response.text);
        setGenerationStatus("");
    } catch(e) {
        console.error(e);
        alert("Failed to generate script.");
    } finally {
        setIsGenerating(false);
    }
  };

  // --- UI Sub Components ---

  return (
    <div className="flex flex-col h-screen w-full bg-[#121212] text-[#e0e0e0] text-xs select-none font-sans">
      
      {/* Export Overlay */}
      {isExporting && (
          <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center backdrop-blur-sm">
              <div className="text-2xl font-bold mb-4 text-cyan-400">Exporting Video...</div>
              <div className="w-96 h-2 bg-neutral-800 rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-400 transition-all duration-100" style={{ width: `${exportProgress}%` }}></div>
              </div>
              <div className="mt-2 font-mono">{exportProgress}%</div>
          </div>
      )}

      {/* Header */}
      <header className="h-14 border-b border-white/10 flex items-center justify-between px-4 bg-[#181818] z-20">
        <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-lg flex items-center justify-center text-white font-bold shadow-lg shadow-cyan-500/20">
                <i className="fa-solid fa-scissors"></i>
            </div>
            <div>
                <div className="font-bold text-sm tracking-wide">OpenCut <span className="text-[10px] bg-neutral-800 px-1 rounded ml-1 text-neutral-400">PRO</span></div>
                <div className="text-[10px] text-neutral-500">Untitled Project</div>
            </div>
        </div>
        
        <div className="flex items-center gap-4">
             {/* Toolbar */}
             <div className="flex bg-neutral-800 rounded-md p-1 gap-1">
                <button onClick={handleUndo} className="w-8 h-8 hover:bg-neutral-700 rounded flex items-center justify-center disabled:opacity-30" disabled={historyIndex <= 0} title="Undo (Ctrl+Z)">
                    <i className="fa-solid fa-rotate-left"></i>
                </button>
                <button onClick={handleRedo} className="w-8 h-8 hover:bg-neutral-700 rounded flex items-center justify-center disabled:opacity-30" disabled={historyIndex >= history.length -1} title="Redo (Ctrl+Y)">
                    <i className="fa-solid fa-rotate-right"></i>
                </button>
                <div className="w-px bg-neutral-700 my-1 mx-1"></div>
                 <button onClick={splitClip} className="w-8 h-8 hover:bg-neutral-700 rounded flex items-center justify-center" title="Split (B)">
                    <i className="fa-solid fa-scissors"></i>
                </button>
                <button onClick={() => selectedClipId && updateClipsWithHistory(clips.filter(c => c.id !== selectedClipId))} className="w-8 h-8 hover:bg-red-900/30 hover:text-red-400 rounded flex items-center justify-center" title="Delete (Del)">
                    <i className="fa-solid fa-trash"></i>
                </button>
             </div>

            <button 
                onClick={exportVideo}
                className="bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white px-6 py-2 rounded-full text-xs font-bold transition-all shadow-lg shadow-cyan-500/20 flex items-center gap-2"
            >
                <i className="fa-solid fa-download"></i>
                Export Video
            </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-16 flex flex-col border-r border-white/5 bg-[#181818] pt-4">
            <NavIcon icon="fa-folder-open" label="Media" active={activeTab === "media"} onClick={() => setActiveTab("media")} />
            <NavIcon icon="fa-layer-group" label="Text" active={activeTab === "text"} onClick={() => setActiveTab("text")} />
            <NavIcon icon="fa-wand-magic-sparkles" label="AI Lab" active={activeTab === "ai"} onClick={() => setActiveTab("ai")} />
        </aside>

        {/* Resource Panel */}
        <div className="w-80 bg-[#1e1e1e] border-r border-white/5 flex flex-col shadow-xl z-10">
            <div className="p-4 border-b border-white/5 font-bold text-sm flex justify-between items-center">
                <span>Resources</span>
                <i className="fa-solid fa-filter text-neutral-500 hover:text-white cursor-pointer"></i>
            </div>
            
            <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-hide">
                {activeTab === "media" && (
                    <>
                         <label className="flex flex-col items-center justify-center w-full h-24 border border-dashed border-neutral-600 rounded-lg hover:bg-neutral-800 hover:border-cyan-500 cursor-pointer transition-all bg-neutral-800/30 group">
                            <i className="fa-solid fa-cloud-arrow-up mb-2 text-neutral-400 group-hover:text-cyan-400 text-lg"></i>
                            <span className="text-neutral-400 group-hover:text-cyan-400">Import Media</span>
                            <input type="file" className="hidden" accept="image/*,video/*" onChange={(e) => {
                                if (e.target.files?.[0]) {
                                    const file = e.target.files[0];
                                    setAssets([...assets, {
                                        id: generateId(),
                                        type: file.type.startsWith('video') ? "video" : "image",
                                        name: file.name,
                                        url: URL.createObjectURL(file)
                                    }]);
                                }
                            }}/>
                        </label>
                        <div className="grid grid-cols-2 gap-2 mt-4">
                            {assets.map(asset => (
                                <div 
                                    key={asset.id} 
                                    className="group relative aspect-video bg-neutral-800 rounded-md overflow-hidden cursor-pointer border border-transparent hover:border-cyan-500 transition-all shadow-sm"
                                    onClick={() => handleDropToTimeline(asset, tracks[1].id)}
                                >
                                    {asset.type === 'video' ? (
                                        <video src={asset.url} className="w-full h-full object-cover" />
                                    ) : (
                                        <img src={asset.url} className="w-full h-full object-cover" />
                                    )}
                                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-[1px]">
                                        <i className="fa-solid fa-plus text-white text-xl drop-shadow-md"></i>
                                    </div>
                                    <div className="absolute bottom-1 left-1 right-1 flex justify-between items-end">
                                        {asset.type === 'video' && <i className="fa-solid fa-video text-[10px] text-white drop-shadow"></i>}
                                        <span className="text-[9px] text-white drop-shadow truncate w-16 text-right">{asset.name}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {activeTab === "text" && (
                    <div className="grid grid-cols-1 gap-2">
                        <button onClick={handleAddText} className="h-16 bg-neutral-800 rounded border border-neutral-700 hover:border-cyan-500 flex items-center justify-center">
                            <span className="text-2xl font-bold text-white">Default Text</span>
                        </button>
                        <button onClick={handleAddText} className="h-16 bg-neutral-800 rounded border border-neutral-700 hover:border-cyan-500 flex items-center justify-center">
                            <span className="text-2xl font-serif text-yellow-400 italic">Serif Style</span>
                        </button>
                        <button onClick={handleAddText} className="h-16 bg-neutral-800 rounded border border-neutral-700 hover:border-cyan-500 flex items-center justify-center">
                            <span className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-violet-500">Gradient</span>
                        </button>
                    </div>
                )}

                 {activeTab === "ai" && (
                    <div className="space-y-4">
                        <div className="bg-neutral-800/50 p-3 rounded-lg border border-white/5">
                             <textarea 
                                className="w-full bg-[#121212] border border-neutral-700 rounded p-2 text-neutral-300 text-xs resize-none focus:outline-none focus:border-cyan-500 transition-colors"
                                rows={3}
                                placeholder="Describe your vision..."
                                value={aiPrompt}
                                onChange={(e) => setAiPrompt(e.target.value)}
                            />
                            <div className="flex gap-2 mt-3">
                                <button onClick={generateAIImage} disabled={isGenerating} className="flex-1 bg-neutral-700 hover:bg-cyan-900 hover:text-cyan-400 py-2 rounded text-[10px] font-bold border border-white/5 transition-all flex flex-col items-center gap-1">
                                     <i className="fa-solid fa-image text-lg"></i>
                                     Image
                                </button>
                                <button onClick={generateAIVideo} disabled={isGenerating} className="flex-1 bg-neutral-700 hover:bg-purple-900 hover:text-purple-400 py-2 rounded text-[10px] font-bold border border-white/5 transition-all flex flex-col items-center gap-1">
                                     <i className="fa-solid fa-film text-lg"></i>
                                     Video (Veo)
                                </button>
                                <button onClick={generateAIScript} disabled={isGenerating} className="flex-1 bg-neutral-700 hover:bg-green-900 hover:text-green-400 py-2 rounded text-[10px] font-bold border border-white/5 transition-all flex flex-col items-center gap-1">
                                     <i className="fa-solid fa-file-lines text-lg"></i>
                                     Script
                                </button>
                            </div>
                            {isGenerating && <div className="mt-2 text-center text-cyan-400 text-[10px] animate-pulse">{generationStatus}</div>}
                        </div>
                        
                        {generatedScript && (
                            <div className="p-3 bg-neutral-800/80 rounded-lg border border-white/5">
                                <div className="text-[10px] text-neutral-500 mb-1 font-bold">SCRIPT</div>
                                <p className="text-neutral-300 italic leading-relaxed">{generatedScript}</p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>

        {/* Center Stage */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#121212]">
            {/* Player */}
            <div className="flex-1 flex items-center justify-center relative p-6 bg-[#0a0a0a]">
                <div className="relative shadow-2xl shadow-black/50 ring-1 ring-white/10 rounded-sm overflow-hidden" style={{ aspectRatio: "16/9", height: "100%", maxHeight: "100%" }}>
                    <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="w-full h-full bg-black" />
                </div>
            </div>

            {/* Middle Bar */}
            <div className="h-10 border-t border-b border-white/5 bg-[#181818] flex items-center justify-between px-4 select-none">
                <div className="flex items-center gap-4 w-1/3 text-xs font-mono">
                    <span className="text-cyan-400">{formatTime(currentTime)}</span>
                    <span className="text-neutral-600">/ {formatTime(projectDuration)}</span>
                </div>
                <div className="flex items-center gap-6 w-1/3 justify-center">
                    <button className="text-neutral-400 hover:text-white transition-colors" onClick={() => setCurrentTime(Math.max(0, currentTime - 5))}><i className="fa-solid fa-backward"></i></button>
                    <button onClick={() => setIsPlaying(!isPlaying)} className="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition-transform">
                        <i className={`fa-solid ${isPlaying ? "fa-pause" : "fa-play"} text-xs ml-0.5`}></i>
                    </button>
                    <button className="text-neutral-400 hover:text-white transition-colors" onClick={() => setCurrentTime(Math.min(projectDuration, currentTime + 5))}><i className="fa-solid fa-forward"></i></button>
                </div>
                <div className="w-1/3 flex justify-end">
                    <input type="range" min="0" max="100" defaultValue="100" className="w-24 accent-cyan-500" />
                </div>
            </div>

            {/* Timeline */}
            <div className="h-80 bg-[#121212] flex flex-col border-t border-white/5 select-none relative">
                
                {/* Time Ruler */}
                <div 
                    className="h-8 bg-[#181818] border-b border-white/5 relative overflow-hidden cursor-ew-resize group"
                    onMouseDown={() => setIsScrubbing(true)}
                >
                     <div className="absolute top-0 bottom-0 left-0 right-0 flex pointer-events-none" style={{ transform: `translateX(${-currentTime * PIXELS_PER_SECOND + 96}px)` }}> 
                         {Array.from({ length: Math.ceil(projectDuration) + 5 }).map((_, i) => (
                             <div key={i} className="flex-shrink-0 border-l border-neutral-700 h-full relative" style={{ width: `${PIXELS_PER_SECOND}px` }}>
                                 <span className="absolute bottom-1 left-1 text-[9px] text-neutral-500 font-mono">{formatTime(i)}</span>
                                 {/* Subticks */}
                                 <div className="absolute bottom-0 left-1/2 h-2 border-l border-neutral-800"></div>
                             </div>
                         ))}
                     </div>
                </div>

                {/* Tracks Area */}
                <div 
                    ref={timelineRef}
                    className="flex-1 overflow-y-auto overflow-x-hidden relative p-2 space-y-1 timeline-track"
                >
                    {/* Playhead Line (Full Height) */}
                    <div className="absolute top-0 bottom-0 w-px bg-cyan-500 z-40 pointer-events-none shadow-[0_0_10px_rgba(34,211,238,0.5)]" style={{ left: `96px` }}>
                        <div className="w-3 h-3 bg-cyan-500 -ml-[5px] rotate-45 transform -translate-y-1/2 shadow-sm shadow-black mt-[-1px]"></div>
                    </div>

                    {tracks.map(track => (
                        <div key={track.id} className="flex h-20 relative">
                             {/* Track Header */}
                            <div className="w-24 flex-shrink-0 bg-[#181818] border-r border-white/5 flex flex-col justify-center px-3 z-20 sticky left-0">
                                <span className="text-[10px] font-bold text-neutral-300 truncate mb-1">{track.name}</span>
                                <div className="flex gap-3 text-neutral-500">
                                    <i className="fa-solid fa-eye hover:text-white cursor-pointer text-[10px]"></i>
                                    <i className="fa-solid fa-volume-high hover:text-white cursor-pointer text-[10px]"></i>
                                    <i className="fa-solid fa-lock hover:text-white cursor-pointer text-[10px]"></i>
                                </div>
                            </div>

                            {/* Track Lane */}
                            <div className="flex-1 relative bg-[#1a1a1a] border-b border-white/5 h-full min-w-[2000px]"
                                 style={{ transform: `translateX(${-currentTime * PIXELS_PER_SECOND}px)` }}>
                                {clips.filter(c => c.trackId === track.id).map(clip => {
                                    const isSelected = selectedClipId === clip.id;
                                    const asset = assets.find(a => a.id === clip.assetId);
                                    return (
                                    <div 
                                        key={clip.id}
                                        className={`absolute top-1 bottom-1 rounded-md overflow-hidden border transition-all group
                                            ${isSelected ? "border-cyan-400 bg-cyan-900/40 z-10" : "border-white/10 bg-[#2a2a2a] hover:bg-[#333]"}
                                            ${dragState?.clipId === clip.id ? "opacity-90 shadow-xl scale-[1.01]" : ""}
                                        `}
                                        style={{
                                            left: `${clip.startTime * PIXELS_PER_SECOND}px`,
                                            width: `${clip.duration * PIXELS_PER_SECOND}px`,
                                            cursor: 'grab'
                                        }}
                                        onMouseDown={(e) => handleClipMouseDown(e, clip, 'move')}
                                    >
                                        {/* Thumbnails strip (Simulated) */}
                                        <div className="absolute inset-0 flex opacity-30 pointer-events-none overflow-hidden">
                                            {asset?.type === 'image' && <img src={asset.url} className="h-full w-auto object-cover opacity-50" />}
                                            {asset?.type === 'video' && Array.from({length: 5}).map((_,i) => (
                                                <div key={i} className="h-full aspect-video bg-white/5 border-r border-white/5"></div>
                                            ))}
                                        </div>

                                        {/* Content Label */}
                                        <div className="relative h-full w-full flex items-center px-2 gap-2 pointer-events-none">
                                            <div className={`w-1 h-full absolute left-0 top-0 ${asset?.type === 'video' ? 'bg-purple-500' : asset?.type === 'image' ? 'bg-orange-500' : 'bg-green-500'}`}></div>
                                            <span className={`text-[10px] font-medium truncate drop-shadow-md ${isSelected ? "text-white" : "text-neutral-300"}`}>
                                                {clip.assetId === 'text-asset' ? clip.properties.text : asset?.name}
                                            </span>
                                        </div>
                                        
                                        {/* Trim Handles (Only visible on hover/select) */}
                                        <div 
                                            className={`absolute left-0 top-0 bottom-0 w-3 cursor-w-resize z-20 hover:bg-cyan-400/50 transition-colors flex items-center justify-center ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                                            onMouseDown={(e) => handleClipMouseDown(e, clip, 'trim-start')}
                                        >
                                            <div className="w-1 h-4 bg-white/50 rounded-full"></div>
                                        </div>
                                        <div 
                                            className={`absolute right-0 top-0 bottom-0 w-3 cursor-e-resize z-20 hover:bg-cyan-400/50 transition-colors flex items-center justify-center ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                                            onMouseDown={(e) => handleClipMouseDown(e, clip, 'trim-end')}
                                        >
                                            <div className="w-1 h-4 bg-white/50 rounded-full"></div>
                                        </div>
                                    </div>
                                )})}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>

        {/* Properties Panel */}
        <aside className="w-72 bg-[#181818] border-l border-white/5 flex flex-col">
            <div className="h-10 border-b border-white/5 flex items-center px-4 font-bold text-sm justify-between bg-[#1e1e1e]">
                <span>Properties</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {selectedClip ? (
                    <>
                         {/* Basic Info */}
                         <div className="flex items-center gap-3 pb-4 border-b border-white/5">
                            <div className="w-10 h-10 bg-neutral-800 rounded flex items-center justify-center text-neutral-500">
                                <i className="fa-solid fa-cube"></i>
                            </div>
                            <div>
                                <div className="font-bold text-xs">Clip Settings</div>
                                <div className="text-[10px] text-neutral-500 font-mono">
                                    {selectedClip.startTime.toFixed(1)}s - {(selectedClip.startTime + selectedClip.duration).toFixed(1)}s
                                </div>
                            </div>
                         </div>

                         <div className="space-y-4">
                             <h4 className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Transform</h4>
                             <PropertyInput 
                                label="Scale" 
                                value={selectedClip.properties.scale} 
                                onChange={v => updateSelectedClip({ scale: v })} 
                                step={0.1} min={0.1} max={5}
                             />
                             <div className="grid grid-cols-2 gap-3">
                                <PropertyInput 
                                    label="Pos X" 
                                    value={selectedClip.properties.x} 
                                    onChange={v => updateSelectedClip({ x: v })} 
                                    step={0.05}
                                />
                                <PropertyInput 
                                    label="Pos Y" 
                                    value={selectedClip.properties.y} 
                                    onChange={v => updateSelectedClip({ y: v })} 
                                    step={0.05}
                                />
                             </div>
                             <PropertyInput 
                                label="Rotate" 
                                value={selectedClip.properties.rotation} 
                                onChange={v => updateSelectedClip({ rotation: v })} 
                                min={-360} max={360}
                             />
                              <PropertyInput 
                                label="Opacity" 
                                value={selectedClip.properties.opacity} 
                                onChange={v => updateSelectedClip({ opacity: v })} 
                                min={0} max={1} step={0.05}
                             />
                        </div>

                        {selectedClip.assetId === 'text-asset' && (
                             <div className="space-y-4 pt-4 border-t border-white/5">
                                <h4 className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Text Style</h4>
                                <div>
                                    <label className="text-[10px] text-neutral-400 mb-1 block">Content</label>
                                    <input 
                                        className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs focus:border-cyan-500 outline-none transition-colors"
                                        value={selectedClip.properties.text}
                                        onChange={(e) => updateSelectedClip({ text: e.target.value })}
                                    />
                                </div>
                                <PropertyInput 
                                    label="Size" 
                                    value={selectedClip.properties.fontSize || 60} 
                                    onChange={v => updateSelectedClip({ fontSize: v })} 
                                    min={10} max={300}
                                />
                                <div>
                                    <label className="text-[10px] text-neutral-400 mb-1 block">Color</label>
                                    <div className="flex gap-2">
                                        <input 
                                            type="color"
                                            className="w-8 h-8 rounded cursor-pointer border-0 p-0 bg-transparent"
                                            value={selectedClip.properties.color}
                                            onChange={(e) => updateSelectedClip({ color: e.target.value })}
                                        />
                                        <input 
                                            className="flex-1 bg-neutral-900 border border-neutral-700 rounded px-2 text-xs font-mono text-neutral-400 uppercase"
                                            value={selectedClip.properties.color}
                                            onChange={(e) => updateSelectedClip({ color: e.target.value })}
                                        />
                                    </div>
                                </div>
                             </div>
                        )}
                    </>
                ) : (
                    <div className="flex flex-col items-center justify-center h-40 text-neutral-600 gap-3 opacity-50">
                        <i className="fa-solid fa-arrow-pointer text-3xl"></i>
                        <p>Select a clip to edit</p>
                    </div>
                )}
            </div>
        </aside>
      </div>
    </div>
  );
};

// --- Subcomponents ---

const NavIcon = ({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) => (
  <button 
    onClick={onClick}
    className={`flex flex-col items-center justify-center w-full h-16 gap-1.5 transition-all relative ${active ? "text-cyan-400 bg-[#1e1e1e]" : "text-neutral-500 hover:text-neutral-300"}`}
  >
    {active && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-cyan-400"></div>}
    <i className={`fa-solid ${icon} text-lg`}></i>
    <span className="text-[10px] font-medium">{label}</span>
  </button>
);

const PropertyInput = ({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) => (
    <div className="flex items-center justify-between gap-3">
        <label className="text-[10px] text-neutral-400 w-12">{label}</label>
        <div className="flex-1 flex items-center gap-2 bg-neutral-900 rounded px-2 py-1 border border-transparent hover:border-neutral-700 focus-within:border-cyan-500/50 transition-colors">
            <input 
                type="range" 
                className="flex-1 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-cyan-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:scale-125 [&::-webkit-slider-thumb]:transition-transform"
                value={value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                step={step}
                min={min !== undefined ? min : 0}
                max={max !== undefined ? max : (value > 10 ? value * 2 : 1)}
            />
            <input 
                className="w-10 bg-transparent text-[10px] font-mono text-right focus:outline-none text-cyan-400"
                value={typeof value === 'number' ? value.toFixed(1) : value}
                onChange={(e) => onChange(parseFloat(e.target.value))}
            />
        </div>
    </div>
);

const formatTime = (time: number) => {
    const m = Math.floor(Math.abs(time) / 60);
    const s = Math.floor(Math.abs(time) % 60);
    const ms = Math.floor((Math.abs(time) % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// --- Root ---

const root = createRoot(document.getElementById("root")!);
root.render(<App />);