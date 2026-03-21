/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  Upload, 
  History, 
  Star, 
  Video,
  Play, 
  Download, 
  Share2,
  Copy,
  Cross, 
  BookOpen,
  ChevronRight,
  Trash2,
  Bookmark
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { GoogleGenAI } from "@google/genai";
import ysFixWebmDuration from 'fix-webm-duration';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Initialize Gemini
const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY is missing. Please set it in your environment variables.");
    return null;
  }
  return new GoogleGenAI({ apiKey });
};

const genAI = getGenAI();

interface Verse {
  reference: string;
  text: string;
}

interface HistoryItem {
  id: string;
  keyword: string;
  timestamp: number;
  verse?: Verse;
  videoId?: string; // ID for IndexedDB storage
  renderedVideoId?: string; // ID for rendered video in IndexedDB
  renderedVideoUrl?: string; // Temporary blob URL for the current session
}

// IndexedDB helper for video storage
const DB_NAME = 'PalavraDiariaDB';
const STORE_NAME = 'videos';

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveVideoToDB = async (id: string, file: File): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(file, id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

const getVideoFromDB = async (id: string): Promise<File | null> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};

const deleteVideoFromDB = async (id: string): Promise<void> => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
};

export default function App() {
  const [keyword, setKeyword] = useState('');
  const [searchMode, setSearchMode] = useState<'keyword' | 'reference'>('keyword');
  const [book, setBook] = useState('');
  const [chapter, setChapter] = useState('');
  const [verseNumber, setVerseNumber] = useState('');
  const [verses, setVerses] = useState<Verse[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVerse, setSelectedVerse] = useState<Verse | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [favorites, setFavorites] = useState<Verse[]>([]);
  const [activeTab, setActiveTab] = useState<'search' | 'history' | 'favorites'>('search');
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderedBlob, setRenderedBlob] = useState<Blob | null>(null);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);

  // Load data from LocalStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('ccb_history');
    const savedFavorites = localStorage.getItem('ccb_favorites');
    if (savedHistory) setHistory(JSON.parse(savedHistory));
    if (savedFavorites) setFavorites(JSON.parse(savedFavorites));
    
    // Check share capability
    setCanNativeShare(!!(navigator.share && navigator.canShare));
  }, []);

  // Save data to LocalStorage
  useEffect(() => {
    localStorage.setItem('ccb_history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    localStorage.setItem('ccb_favorites', JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    if (videoUrl) {
      console.log("Novo Video URL:", videoUrl);
    }
  }, [videoUrl]);

  const handleSelectVerse = async (verse: Verse) => {
    setSelectedVerse(verse);
    
    // If a video is already uploaded, attach it to this verse in history
    if (videoFile) {
      const videoId = `vid_${Date.now()}`;
      await saveVideoToDB(videoId, videoFile);
      
      const hId = Date.now().toString();
      const newHistoryItem: HistoryItem = {
        id: hId,
        keyword: verse.reference,
        timestamp: Date.now(),
        verse: verse,
        videoId: videoId
      };
      setHistory(prev => [newHistoryItem, ...prev.slice(0, 19)]);
      setCurrentHistoryId(hId);
      showToast('Vídeo anexado ao versículo!');
    }
  };

  const handleSearch = async (e?: React.FormEvent, searchKeyword?: string) => {
    if (e) e.preventDefault();
    const term = searchKeyword || keyword;
    if (!term.trim()) return;

    setLoading(true);
    setVerses([]);
    
    if (!genAI) {
      setLoading(false);
      showToast("Erro: Chave API não configurada.");
      return;
    }
    
    try {
      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Encontre 5 versículos bíblicos (versão Almeida Corrigida Fiel) relacionados à palavra-chave: "${term}". 
        Retorne APENAS um array JSON de objetos com as propriedades: "reference" (ex: João 3:16) e "text" (o conteúdo do versículo). 
        Não inclua explicações, apenas o JSON puro.`,
        config: {
          responseMimeType: "application/json",
        }
      });

      const data = JSON.parse(response.text || "[]");
      setVerses(data);
      
      // Add to history if it's a new search
      if (!searchKeyword) {
        const hId = Date.now().toString();
        const newHistoryItem: HistoryItem = {
          id: hId,
          keyword: term,
          timestamp: Date.now(),
          verse: data[0] // Save the first result as reference
        };
        setHistory(prev => [newHistoryItem, ...prev.slice(0, 19)]);
        setCurrentHistoryId(hId);
      }
    } catch (error) {
      console.error("Search failed", error);
    } finally {
      setLoading(false);
    }
  };

  const handleReferenceSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!book.trim() || !chapter.trim()) return;

    setLoading(true);
    setVerses([]);
    
    if (!genAI) {
      setLoading(false);
      showToast("Erro: Chave API não configurada.");
      return;
    }
    
    try {
      const reference = `${book} ${chapter}${verseNumber ? ':' + verseNumber : ''}`;
      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Busque o conteúdo bíblico (versão Almeida Corrigida Fiel) para a referência: "${reference}". 
        Se a referência for um versículo específico, retorne um objeto JSON. 
        Se for um capítulo inteiro (sem versículo especificado), retorne TODOS os versículos desse capítulo como um array de objetos JSON.
        Cada objeto deve ter as propriedades: "reference" (ex: João 3:1) e "text" (o conteúdo do versículo).
        Retorne APENAS o JSON puro, sem blocos de código ou explicações.`,
        config: {
          responseMimeType: "application/json",
        }
      });

      const text = response.text || "[]";
      let data = JSON.parse(text);
      const versesArray = Array.isArray(data) ? data : [data];
      setVerses(versesArray);
      
      // Add to history using the first verse as reference if multiple
      const hId = Date.now().toString();
      const newHistoryItem: HistoryItem = {
        id: hId,
        keyword: reference,
        timestamp: Date.now(),
        verse: versesArray[0]
      };
      setHistory(prev => [newHistoryItem, ...prev.slice(0, 19)]);
      setCurrentHistoryId(hId);
    } catch (error) {
      console.error("Reference search failed", error);
      showToast("Erro ao buscar referência.");
    } finally {
      setLoading(false);
    }
  };

  const handleVideoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Reset states
      setVideoDuration(0);
      setVideoError(false);
      
      // Check file size (limit to 100MB for stability on mobile)
      if (file.size > 100 * 1024 * 1024) {
        showToast('O vídeo é muito grande. Use arquivos menores que 100MB.');
        return;
      }

      setIsRendering(true);
      setRenderProgress(0);
      
      const tempVideo = document.createElement('video');
      tempVideo.preload = 'metadata';
      const objectUrl = URL.createObjectURL(file);
      
      const cleanup = () => {
        tempVideo.onloadedmetadata = null;
        tempVideo.onerror = null;
        URL.revokeObjectURL(objectUrl);
        e.target.value = '';
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        showToast('O carregamento do vídeo demorou demais.');
        setIsRendering(false);
      }, 15000);

      tempVideo.onerror = () => {
        clearTimeout(timeoutId);
        cleanup();
        showToast('Erro ao carregar o vídeo. Verifique o formato.');
        setIsRendering(false);
      };

      tempVideo.onloadedmetadata = async () => {
        clearTimeout(timeoutId);
        // Wait a bit to ensure duration is stable
        await new Promise(r => setTimeout(r, 1000));
        
        let duration = tempVideo.duration;
        
        // Fix for Infinity/NaN duration on some mobile browsers
        if (duration === Infinity || isNaN(duration) || duration < 0.1) {
          console.log("Duração inválida detectada, tentando forçar leitura...");
          tempVideo.currentTime = 1e10; // Seek to end
          await new Promise(r => setTimeout(r, 500));
          duration = tempVideo.duration;
          tempVideo.currentTime = 0; // Seek back
        }

        console.log("Duração final detectada:", duration);
        // Cap at 60s for safety, but use detected duration
        const finalDuration = (duration > 0 && duration < 300) ? duration : 30;
        setVideoDuration(finalDuration);
        cleanup();
        
        try {
          const videoId = `vid_${Date.now()}`;
          await saveVideoToDB(videoId, file);
          
          setVideoFile(file);
          if (videoUrl) URL.revokeObjectURL(videoUrl);
          
          // Small delay to help mobile browsers manage blob memory
          await new Promise(r => setTimeout(r, 100));
          
          const url = URL.createObjectURL(file);
          setVideoUrl(url);

          // Update history
          if (currentHistoryId) {
            setHistory(prev => prev.map(h => 
              h.id === currentHistoryId ? { ...h, videoId } : h
            ));
          } else if (selectedVerse) {
            const hId = Date.now().toString();
            const newHistoryItem: HistoryItem = {
              id: hId,
              keyword: selectedVerse.reference,
              timestamp: Date.now(),
              verse: selectedVerse,
              videoId: videoId
            };
            setHistory(prev => [newHistoryItem, ...prev.slice(0, 19)]);
            setCurrentHistoryId(hId);
          }
          
          showToast('Vídeo anexado com sucesso!');
        } catch (err) {
          console.error("Save video failed", err);
          showToast('Erro ao salvar o vídeo.');
        } finally {
          setIsRendering(false);
        }
      };

      tempVideo.src = objectUrl;
    }
  };

  const toggleFavorite = (verse: Verse) => {
    const isFav = favorites.some(f => f.reference === verse.reference);
    if (isFav) {
      setFavorites(prev => prev.filter(f => f.reference !== verse.reference));
    } else {
      setFavorites(prev => [...prev, verse]);
    }
  };

  const clearHistory = async () => {
    // Clear videos from DB too
    for (const item of history) {
      if (item.videoId) {
        await deleteVideoFromDB(item.videoId);
      }
    }
    setHistory([]);
  };

  useEffect(() => {
    if (renderedBlob && currentHistoryId) {
      const url = URL.createObjectURL(renderedBlob);
      setHistory(prev => prev.map(h => 
        h.id === currentHistoryId ? { ...h, renderedVideoUrl: url } : h
      ));
    }
  }, [renderedBlob, currentHistoryId]);

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [showRenderOverlay, setShowRenderOverlay] = useState(false);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setLogoUrl(url);
      showToast("Logo carregada com sucesso!");
    }
  };

  const handleRender = () => {
    if (isRendering || !selectedVerse || !videoUrl) return;
    if (videoDuration <= 0) {
      showToast("Aguarde a detecção da duração do vídeo...");
      return;
    }
    setIsRendering(true);
    setShowRenderOverlay(true);
    setRenderProgress(1); 
    setRenderedBlob(null);
  };

  useEffect(() => {
    if (showRenderOverlay && renderCanvasRef.current && isRendering && !renderedBlob) {
      const startRenderingProcess = async () => {
        let renderVideo: HTMLVideoElement | null = null;
        let canvas: HTMLCanvasElement | null = renderCanvasRef.current;

        try {
          if (!canvas) return;

          // Load Logo if exists
          let logoImg: HTMLImageElement | null = null;
          if (logoUrl) {
            logoImg = new Image();
            logoImg.src = logoUrl;
            await new Promise((resolve) => {
              logoImg!.onload = resolve;
              logoImg!.onerror = resolve;
            });
          }

          renderVideo = document.createElement('video');
          renderVideo.muted = true;
          renderVideo.playsInline = true;
          renderVideo.src = videoUrl!;
          
          // Wait for metadata to get correct dimensions
          await new Promise((resolve) => {
            renderVideo!.onloadedmetadata = resolve;
            renderVideo!.onerror = resolve;
            renderVideo!.load();
          });

          try {
            await document.fonts.ready;
          } catch (e) {}

          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) throw new Error("Erro no motor gráfico.");
          
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          // Cap resolution at 1080p height for high quality
          const targetHeight = 1920;
          const originalWidth = renderVideo.videoWidth || 1080;
          const originalHeight = renderVideo.videoHeight || 1920;
          const aspectRatio = originalWidth / originalHeight;
          
          canvas.height = Math.min(originalHeight, targetHeight);
          canvas.width = Math.round(canvas.height * aspectRatio);
          
          console.log("Dimensões do canvas (Alta Qualidade):", canvas.width, "x", canvas.height);

          if (renderVideo.readyState < 3) { 
            await new Promise((resolve) => {
              const timeout = setTimeout(resolve, 10000);
              const onReady = () => {
                clearTimeout(timeout);
                renderVideo?.removeEventListener('canplaythrough', onReady);
                resolve(null);
              };
              renderVideo?.addEventListener('canplaythrough', onReady);
              renderVideo?.load();
            });
          }

          ctx.fillStyle = 'black';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(renderVideo, 0, 0, canvas.width, canvas.height);

          let stream: MediaStream;
          try {
            // Use 60fps for maximum fluidity
            stream = canvas.captureStream(60);
          } catch (e) {
            try {
              stream = (canvas as any).captureStream(60);
            } catch (e2) {
              throw new Error("Seu dispositivo não suporta gravação de vídeo.");
            }
          }
          
          // Prioritize MP4 for better compatibility if supported (especially on iOS)
          const types = [
            'video/mp4;codecs=h264,aac',
            'video/mp4;codecs=h264',
            'video/mp4',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp9,opus',
            'video/webm'
          ];
          const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
          const isWebM = mimeType.includes('webm');
          
          if (!stream || stream.getTracks().length === 0) {
            throw new Error("Falha ao iniciar o fluxo de vídeo.");
          }
          
          let recorder: MediaRecorder;
          try {
            recorder = new MediaRecorder(stream, { 
              mimeType: mimeType || undefined,
              videoBitsPerSecond: 12000000 // 12 Mbps for high quality
            });
          } catch (err) {
            throw new Error("Erro ao configurar o gravador de vídeo.");
          }
          
          const chunks: Blob[] = [];
          recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
              chunks.push(e.data);
            }
          };

          recorder.onstop = async () => {
            setShowRenderOverlay(false);
            if (chunks.length === 0) {
              showToast("Falha na captura. Tente novamente.");
              setIsRendering(false);
              return;
            }

            // Ensure the final blob has the correct mime type
            const rawBlob = new Blob(chunks, { type: mimeType || 'video/mp4' });
            const finalDurationMs = Math.round(maxDuration * 1000);
            
            console.log("Final blob size:", rawBlob.size, "Type:", rawBlob.type);

            const processFinalBlob = async (blob: Blob) => {
              setRenderedBlob(blob);
              
              if (currentHistoryId) {
                const renderedId = `rendered_${currentHistoryId}`;
                const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
                const renderedFile = new File([blob], `palavra_${Date.now()}.${extension}`, { type: blob.type });
                await saveVideoToDB(renderedId, renderedFile);
                setHistory(prev => prev.map(h => 
                  h.id === currentHistoryId ? { ...h, renderedVideoId: renderedId } : h
                ));
              }

              setIsRendering(false);
              setRenderProgress(0);
            };

            if (isWebM) {
              console.log("Iniciando correção de duração para WebM:", finalDurationMs, "ms");
              ysFixWebmDuration(rawBlob, finalDurationMs, (fixedBlob) => {
                processFinalBlob(fixedBlob);
              });
            } else {
              processFinalBlob(rawBlob);
            }
          };

          // Adjust font sizes based on resolution (scaling from 1080p base)
          const scaleFactor = canvas.width / 1080;
          const fontSize = Math.round(64 * scaleFactor);
          const refFontSize = Math.round(48 * scaleFactor);
          const lineHeight = fontSize * 1.3;
          const maxWidth = canvas.width - (200 * scaleFactor);
          ctx.font = `italic ${fontSize}px "Libre Baskerville"`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          
          const words = selectedVerse!.text.split(' ');
          let line = '';
          const lines: string[] = [];
          for (let n = 0; n < words.length; n++) {
            let testLine = line + words[n] + ' ';
            if (ctx.measureText(testLine).width > maxWidth && n > 0) {
              lines.push(line.trim());
              line = words[n] + ' ';
            } else {
              line = testLine;
            }
          }
          lines.push(line.trim());
          const startY = (canvas.height - (lines.length * lineHeight)) / 2;
          const referenceText = selectedVerse!.reference.toUpperCase();

          const maxDuration = videoDuration > 0 ? videoDuration : 30;
          console.log("Iniciando renderização com duração:", maxDuration);
          let renderStartTime = 0;
          let framesDrawn = 0;
          
          renderVideo.currentTime = 0;
          // Only loop if we are forcing a duration longer than the video
          renderVideo.loop = maxDuration > videoDuration + 0.5;
          
          await renderVideo.play().catch(async () => {
            renderVideo!.muted = true;
            await renderVideo!.play();
          });

          let lastVideoTime = -1;
          let lastCheckTime = Date.now();

          const fps = 60;
          const frameInterval = 1000 / fps;
          let lastFrameTime = Date.now();

          const renderLoop = () => {
            if (!isRendering || !canvas || !ctx || !renderVideo) {
              if (recorder && recorder.state !== 'inactive') recorder.stop();
              return;
            }

            const now = Date.now();
            const elapsed = now - lastFrameTime;

            // Draw as fast as possible but cap at target FPS
            if (elapsed >= frameInterval) {
              lastFrameTime = now - (elapsed % frameInterval);

              // Draw frame - even if video isn't perfectly ready, we draw something to keep stream alive
              ctx.imageSmoothingEnabled = true;
              ctx.imageSmoothingQuality = 'high';
              
              // Draw background (black) first
              ctx.fillStyle = 'black';
              ctx.fillRect(0, 0, canvas.width, canvas.height);

              if (renderVideo.readyState >= 2) {
                ctx.drawImage(renderVideo, 0, 0, canvas.width, canvas.height);
              }
              
              // Overlay darkness
              ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
              ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Draw Logo
                if (logoImg && logoImg.complete) {
                  const logoSize = Math.round(180 * scaleFactor);
                  const padding = Math.round(60 * scaleFactor);
                  
                  // Simple shadow for logo (much faster than shadowBlur)
                  ctx.fillStyle = 'rgba(0,0,0,0.3)';
                  ctx.beginPath();
                  ctx.arc(canvas.width / 2, padding + logoSize / 2 + 4, logoSize / 2, 0, Math.PI * 2);
                  ctx.fill();
                  
                  ctx.drawImage(logoImg, (canvas.width - logoSize) / 2, padding, logoSize, logoSize);
                }

                // Text Settings
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                // Verse Text
                const verseFont = `italic ${fontSize}px "Libre Baskerville"`;
                ctx.font = verseFont;
                let currentY = startY;
                
                lines.forEach((l) => {
                  const text = `"${l}"`;
                  const x = canvas.width / 2;
                  const y = currentY + lineHeight / 2;
                  
                  // Manual Drop Shadow (High Performance)
                  ctx.fillStyle = 'rgba(0,0,0,0.8)';
                  ctx.fillText(text, x + 2, y + 2);
                  
                  ctx.fillStyle = 'white';
                  ctx.fillText(text, x, y);
                  currentY += lineHeight;
                });

                // Reference Text
                ctx.fillStyle = '#D4AF37';
                const refFont = `bold ${refFontSize}px "Cinzel"`;
                ctx.font = refFont;
                const refY = currentY + (80 * scaleFactor);
                const refX = canvas.width / 2;
                
                // Manual Drop Shadow for Reference
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.fillText(referenceText, refX + 1, refY + 1);
                
                ctx.fillStyle = '#D4AF37';
                ctx.fillText(referenceText, refX, refY);

                // Decorative Lines
                const refWidth = ctx.measureText(referenceText).width;
                ctx.strokeStyle = 'rgba(212, 175, 55, 0.8)';
                ctx.lineWidth = Math.max(2, 6 * scaleFactor);
                const offset = refWidth / 2 + (30 * scaleFactor);
                const lineLength = 60 * scaleFactor;
                
                ctx.beginPath();
                ctx.moveTo(canvas.width / 2 - offset - lineLength, refY);
                ctx.lineTo(canvas.width / 2 - offset, refY);
                ctx.moveTo(canvas.width / 2 + offset, refY);
                ctx.lineTo(canvas.width / 2 + offset + lineLength, refY);
                ctx.stroke();

              framesDrawn++;
              // Start recording after a few frames to ensure stability
              if (framesDrawn === 10 && recorder.state === 'inactive') {
                renderStartTime = Date.now();
                recorder.start();
              }

              if (renderStartTime > 0) {
                const nowRender = Date.now();
                const elapsedSeconds = (nowRender - renderStartTime) / 1000;
                
                // Ensure video keeps playing
                if (renderVideo.paused && elapsedSeconds < maxDuration) {
                  renderVideo.play().catch(() => {});
                }

                if (elapsedSeconds >= maxDuration) {
                  if (recorder && recorder.state !== 'inactive') {
                    recorder.stop();
                  }
                  return;
                }
                
                const progress = Math.max(1, Math.min((elapsedSeconds / maxDuration) * 100, 100));
                setRenderProgress(Math.round(progress));
              }
            }
            
            requestAnimationFrame(renderLoop);
          };
          renderLoop();
        } catch (error: any) {
          console.error("Render failed", error);
          showToast(error.message || "Erro na renderização.");
          setIsRendering(false);
          setShowRenderOverlay(false);
        }
      };
      startRenderingProcess();
    }
  }, [showRenderOverlay, isRendering, videoDuration]);

  const handleDownloadImage = async () => {
    if (!selectedVerse || !videoRef.current) return;
    
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Load Logo if exists
    let logoImg: HTMLImageElement | null = null;
    if (logoUrl) {
      logoImg = new Image();
      logoImg.src = logoUrl;
      await new Promise((resolve) => {
        logoImg!.onload = resolve;
        logoImg!.onerror = resolve;
      });
    }

    // Draw current video frame
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    
    // Overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw Logo
    if (logoImg && logoImg.complete) {
      const logoSize = 240;
      const padding = 100;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 20;
      ctx.drawImage(logoImg, (canvas.width - logoSize) / 2, padding, logoSize, logoSize);
      ctx.shadowBlur = 0;
    }
    
    // Text
    const fontSize = 64;
    const lineHeight = fontSize * 1.3;
    const maxWidth = canvas.width - 200;
    ctx.font = `italic ${fontSize}px "Libre Baskerville"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'white';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 12;

    const words = selectedVerse.text.split(' ');
    let line = '';
    const lines: string[] = [];
    for (let n = 0; n < words.length; n++) {
      let testLine = line + words[n] + ' ';
      if (ctx.measureText(testLine).width > maxWidth && n > 0) {
        lines.push(line.trim());
        line = words[n] + ' ';
      } else {
        line = testLine;
      }
    }
    lines.push(line.trim());
    
    let currentY = (canvas.height - (lines.length * lineHeight)) / 2;
    lines.forEach((l) => {
      ctx.fillText(`"${l}"`, canvas.width / 2, currentY + lineHeight / 2);
      currentY += lineHeight;
    });
    
    // Reference
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 48px "Cinzel"';
    ctx.fillText(selectedVerse.reference.toUpperCase(), canvas.width / 2, currentY + 80);

    const link = document.createElement('a');
    link.download = `palavra_diaria_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast("Imagem baixada com sucesso!");
  };

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const handleShare = async () => {
    if (!renderedBlob || !selectedVerse) return;
    
    const extension = renderedBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([renderedBlob], `palavra_diaria.${extension}`, { type: renderedBlob.type });

    try {
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'A Palavra Diária',
          text: `"${selectedVerse.text}" - ${selectedVerse.reference}`,
        });
      } else {
        throw new Error('ShareNotSupported');
      }
    } catch (err: any) {
      console.error('Erro ao compartilhar:', err);
      
      // Se for erro de permissão (comum em iframes) ou não suportado
      const isPermissionError = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      
      if (isPermissionError) {
        // No alert here to avoid annoyance, just proceed to download
        console.log('Share blocked by environment, falling back to download');
      } else if (err.name !== 'AbortError') {
        alert('Compartilhamento não disponível. O vídeo será baixado.');
      }
      
      if (err.name !== 'AbortError') {
        handleDownload();
        try {
          await navigator.clipboard.writeText(`"${selectedVerse.text}" - ${selectedVerse.reference}`);
          showToast('Vídeo baixado e texto copiado!');
        } catch (e) {
          showToast('Vídeo baixado!');
        }
      }
    }
  };

  const handleDownload = () => {
    if (!renderedBlob) return;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const extension = renderedBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(renderedBlob);
    
    if (isIOS) {
      // On iOS, opening in a new tab is often more reliable for saving to gallery
      window.open(url, '_blank');
      showToast('Vídeo aberto! Pressione e segure para salvar.');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = `palavra_diaria_${Date.now()}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Vídeo salvo na galeria!');
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert('Texto copiado!');
    } catch (err) {
      console.error('Erro ao copiar:', err);
    }
  };

  return (
    <div className="min-h-screen flex flex-col font-serif selection:bg-action-tan/30 nature-gradient">
      {/* Full Screen Render Overlay */}
      <AnimatePresence>
        {showRenderOverlay && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10000] bg-text-dark flex flex-col items-center justify-center p-6"
          >
            <div className="relative w-full max-w-[300px] aspect-[9/16] bg-black rounded-2xl overflow-hidden shadow-2xl border-2 border-action-tan/30 mb-8">
              <canvas 
                ref={renderCanvasRef}
                className="w-full h-full object-contain"
              />
              <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center text-white p-4 text-center">
                <div className="w-12 h-12 border-4 border-action-tan border-t-transparent rounded-full animate-spin mb-4" />
                <h3 className="font-display text-lg tracking-widest text-action-tan mb-2 uppercase">GERANDO VÍDEO</h3>
                <p className="text-xs opacity-70 mb-4">Mantenha esta tela aberta e o celular ligado.</p>
                <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-action-tan"
                    initial={{ width: 0 }}
                    animate={{ width: `${renderProgress}%` }}
                  />
                </div>
                <span className="text-[10px] font-bold mt-2">{renderProgress}%</span>
              </div>
            </div>
            <button 
              onClick={() => {
                setIsRendering(false);
                setShowRenderOverlay(false);
              }}
              className="px-8 py-3 bg-white/10 hover:bg-white/20 rounded-full text-white text-xs uppercase tracking-widest transition-colors"
            >
              Cancelar Geração
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 20 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-0 left-1/2 -translate-x-1/2 z-[100] bg-text-dark text-action-tan px-6 py-3 rounded-full shadow-2xl border border-action-tan/50 font-display text-xs tracking-widest uppercase flex items-center gap-2"
          >
            <div className="w-2 h-2 bg-action-tan rounded-full animate-pulse" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md text-text-dark py-10 px-6 shadow-sm border-b border-text-muted/10">
        {!genAI && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-600 text-[10px] py-1 text-center mb-4 rounded">
            Atenção: Chave API não configurada. Configure GEMINI_API_KEY no ambiente.
          </div>
        )}
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="flex items-center gap-5">
            <div className="p-4 bg-secondary-green/10 rounded-full border border-secondary-green/20">
              <BookOpen className="w-10 h-10 text-secondary-green" />
            </div>
            <div>
              <h1 className="font-display text-4xl font-bold tracking-tight text-text-dark">A PALAVRA DIÁRIA</h1>
              <p className="text-sm text-text-muted tracking-[0.15em] font-medium mt-1">MEDITAÇÃO E COMPARTILHAMENTO</p>
            </div>
          </div>
          
          <nav className="flex gap-2 bg-text-muted/5 p-1.5 rounded-full border border-text-muted/10">
            {[
              { id: 'search', icon: Search, label: 'BUSCA', color: 'bg-primary-blue' },
              { id: 'history', icon: History, label: 'HISTÓRICO', color: 'bg-text-dark' },
              { id: 'favorites', icon: Star, label: 'FAVORITOS', color: 'bg-secondary-green' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "flex items-center gap-2 px-6 py-2.5 rounded-full text-xs font-bold tracking-widest transition-all duration-300",
                  activeTab === tab.id 
                    ? `${tab.color} text-white shadow-md` 
                    : "text-text-muted hover:text-text-dark hover:bg-text-muted/10"
                )}
              >
                <tab.icon className="w-4 h-4" />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Search & Lists */}
        <div className="lg:col-span-5 space-y-6">
          <AnimatePresence mode="wait">
            {activeTab === 'search' && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="flex gap-3 mb-6">
                  <button
                    onClick={() => setSearchMode('keyword')}
                    className={cn(
                      "flex-1 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border",
                      searchMode === 'keyword' 
                        ? "bg-primary-blue text-white border-primary-blue shadow-md" 
                        : "bg-white text-text-muted border-text-muted/10 hover:border-text-muted/30"
                    )}
                  >
                    Palavra-Chave
                  </button>
                  <button
                    onClick={() => setSearchMode('reference')}
                    className={cn(
                      "flex-1 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border",
                      searchMode === 'reference' 
                        ? "bg-primary-blue text-white border-primary-blue shadow-md" 
                        : "bg-white text-text-muted border-text-muted/10 hover:border-text-muted/30"
                    )}
                  >
                    Referência
                  </button>
                </div>

                {searchMode === 'keyword' ? (
                  <form onSubmit={handleSearch} className="relative group">
                    <input
                      type="text"
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                      placeholder="Digite uma palavra-chave..."
                      className="w-full bg-white border border-text-muted/20 focus:border-action-tan rounded-xl py-4 pl-12 pr-4 outline-none transition-all shadow-sm group-hover:shadow-md soft-border"
                    />
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted group-focus-within:text-action-tan transition-colors" />
                    <button 
                      type="submit"
                      disabled={loading}
                      className="absolute right-2 top-1/2 -translate-y-1/2 bg-action-tan text-white px-6 py-2 rounded-lg text-sm font-bold uppercase tracking-wider hover:bg-action-tan/90 disabled:opacity-50 transition-all"
                    >
                      {loading ? '...' : 'Buscar'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleReferenceSearch} className="grid grid-cols-12 gap-3">
                    <div className="col-span-6 relative group">
                      <input
                        type="text"
                        value={book}
                        onChange={(e) => setBook(e.target.value)}
                        placeholder="Livro (ex: João)"
                        className="w-full bg-white border border-text-muted/20 focus:border-action-tan rounded-xl py-4 pl-4 pr-4 outline-none transition-all shadow-sm group-hover:shadow-md text-sm soft-border"
                      />
                    </div>
                    <div className="col-span-3 relative group">
                      <input
                        type="number"
                        value={chapter}
                        onChange={(e) => setChapter(e.target.value)}
                        placeholder="Cap."
                        className="w-full bg-white border border-text-muted/20 focus:border-action-tan rounded-xl py-4 pl-4 pr-4 outline-none transition-all shadow-sm group-hover:shadow-md text-sm soft-border"
                      />
                    </div>
                    <div className="col-span-3 relative group">
                      <input
                        type="number"
                        value={verseNumber}
                        onChange={(e) => setVerseNumber(e.target.value)}
                        placeholder="Ver."
                        className="w-full bg-white border border-text-muted/20 focus:border-action-tan rounded-xl py-4 pl-4 pr-4 outline-none transition-all shadow-sm group-hover:shadow-md text-sm soft-border"
                      />
                    </div>
                    <button 
                      type="submit"
                      disabled={loading}
                      className="col-span-12 bg-action-tan text-white py-4 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-action-tan/90 disabled:opacity-50 transition-all shadow-lg"
                    >
                      {loading ? 'Buscando...' : 'Buscar Versículo'}
                    </button>
                  </form>
                )}

                <div className="space-y-4">
                  <h2 className="font-display text-xl font-bold text-text-dark flex items-center gap-2">
                    <ChevronRight className="w-5 h-5 text-secondary-green" />
                    RESULTADOS DA BÍBLIA
                  </h2>
                  
                  <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                    {verses.length === 0 && !loading && (
                      <div className="text-center py-16 border-2 border-dashed border-text-muted/10 rounded-2xl bg-white/30">
                        <BookOpen className="w-16 h-16 text-text-muted/20 mx-auto mb-4" />
                        <p className="text-text-muted text-sm italic">Nenhum versículo encontrado ainda.</p>
                      </div>
                    )}

                    {verses.map((v, idx) => (
                      <motion.div
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        key={`${v.reference}-${idx}`}
                        onClick={() => handleSelectVerse(v)}
                        className={cn(
                          "p-6 rounded-2xl cursor-pointer transition-all border group relative",
                          selectedVerse?.reference === v.reference
                            ? "bg-white text-text-dark border-secondary-green shadow-xl scale-[1.02] ring-1 ring-secondary-green/20"
                            : "bg-white/60 border-text-muted/5 hover:border-secondary-green/30 hover:shadow-md"
                        )}
                      >
                        <div className="flex justify-between items-start mb-3">
                          <span className={cn(
                            "font-display text-sm font-bold tracking-widest",
                            selectedVerse?.reference === v.reference ? "text-secondary-green" : "text-text-muted"
                          )}>
                            {v.reference}
                          </span>
                          <div className="flex gap-2">
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(`"${v.text}" - ${v.reference}`);
                              }}
                              className="p-1.5 rounded-full hover:bg-text-muted/5 transition-colors"
                              title="Copiar texto"
                            >
                              <Copy className={cn("w-4 h-4", selectedVerse?.reference === v.reference ? "text-text-dark/40" : "text-text-muted/20")} />
                            </button>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleFavorite(v);
                              }}
                              className="p-1.5 rounded-full hover:bg-text-muted/5 transition-colors"
                            >
                              <Star className={cn(
                                "w-4 h-4",
                                favorites.some(f => f.reference === v.reference) 
                                  ? "fill-secondary-green text-secondary-green" 
                                  : (selectedVerse?.reference === v.reference ? "text-text-dark/40" : "text-text-muted/20")
                              )} />
                            </button>
                          </div>
                        </div>
                        <p className={cn(
                          "font-serif text-lg leading-relaxed italic",
                          selectedVerse?.reference === v.reference ? "text-text-dark" : "text-text-muted"
                        )}>
                          "{v.text}"
                        </p>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'history' && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-4"
              >
                <div className="flex justify-between items-center">
                  <h2 className="font-display text-lg text-navy/60">Histórico de Buscas</h2>
                  <button 
                    onClick={clearHistory}
                    className="text-xs text-red-500 hover:underline flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" /> Limpar tudo
                  </button>
                </div>
                {history.length === 0 ? (
                  <p className="text-center py-10 text-navy/30 italic">Sem histórico.</p>
                ) : (
                  history.map((item) => (
                    <div 
                      key={item.id}
                      onClick={async () => {
                        if (item.verse) {
                          setSelectedVerse(item.verse);
                          setVerses([item.verse]);
                        }
                        setCurrentHistoryId(item.id);
                        if (item.renderedVideoId) {
                          const file = await getVideoFromDB(item.renderedVideoId);
                          if (file) {
                            setRenderedBlob(file);
                          }
                        } else if (item.videoId) {
                          const file = await getVideoFromDB(item.videoId);
                          if (file) {
                            setVideoFile(file);
                            if (videoUrl) URL.revokeObjectURL(videoUrl);
                            setVideoUrl(URL.createObjectURL(file));
                          }
                        }
                        setActiveTab('search');
                      }}
                      className="flex items-center justify-between p-4 bg-white border border-navy/5 rounded-xl hover:border-gold cursor-pointer transition-all group"
                    >
                      <div className="flex items-center gap-3">
                        {item.videoId ? (
                          <Video className="w-4 h-4 text-gold" />
                        ) : (
                          <History className="w-4 h-4 text-navy/30 group-hover:text-gold" />
                        )}
                        <div className="flex flex-col">
                          <span className="font-medium text-navy/80">{item.keyword}</span>
                          <div className="flex gap-2 mt-1">
                            {item.videoId && <span className="text-[8px] text-gold uppercase font-bold bg-gold/10 px-1 rounded">Original</span>}
                            {item.renderedVideoId && <span className="text-[8px] text-green-600 uppercase font-bold bg-green-50 px-1 rounded">Renderizado</span>}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] text-navy/40 uppercase tracking-tighter">
                        {new Date(item.timestamp).toLocaleDateString()}
                      </span>
                    </div>
                  ))
                )}
              </motion.div>
            )}

            {activeTab === 'favorites' && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-4"
              >
                <h2 className="font-display text-lg text-navy/60">Versículos Favoritos</h2>
                {favorites.length === 0 ? (
                  <p className="text-center py-10 text-navy/30 italic">Nenhum favorito salvo.</p>
                ) : (
                  favorites.map((v) => (
                    <div 
                      key={v.reference}
                      onClick={() => {
                        handleSelectVerse(v);
                        setActiveTab('search');
                      }}
                      className="p-4 bg-white border border-navy/5 rounded-xl hover:border-gold cursor-pointer transition-all"
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-display text-xs text-gold tracking-widest">{v.reference}</span>
                        <Bookmark className="w-3 h-3 text-gold fill-gold" />
                      </div>
                      <p className="font-serif text-sm italic text-navy/70 line-clamp-2">"{v.text}"</p>
                    </div>
                  ))
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right Column: Video Preview & Overlay */}
        <div className="lg:col-span-7">
          <div className="sticky top-6 space-y-6">
            <div className="bg-text-dark rounded-3xl overflow-hidden shadow-2xl border-4 border-action-tan/20 aspect-[9/16] max-h-[80vh] mx-auto relative group">
              {videoUrl ? (
                <>
                  <video 
                    key={videoUrl}
                    ref={videoRef}
                    src={videoUrl} 
                    className="w-full h-full object-cover pointer-events-none"
                    controls={false}
                    loop
                    muted
                    autoPlay
                    playsInline
                    webkit-playsinline="true"
                    preload="auto"
                    onLoadedData={() => setVideoError(false)}
                    onError={(e) => {
                      console.error("Erro no elemento de vídeo:", e);
                      setVideoError(true);
                    }}
                  />
                  
                  {videoError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-text-dark/90 p-6 text-center z-50">
                      <Video className="w-12 h-12 text-action-tan/50 mb-4" />
                      <p className="text-white font-bold mb-4">Erro ao carregar o vídeo</p>
                      <button 
                        onClick={() => {
                          if (videoRef.current) {
                            setVideoError(false);
                            videoRef.current.load();
                          }
                        }}
                        className="px-6 py-2 bg-action-tan text-white font-bold rounded-full hover:bg-white transition-colors"
                      >
                        Tentar Recarregar
                      </button>
                    </div>
                  )}
                  
                  {/* Overlay Text */}
                  <AnimatePresence>
                    {selectedVerse && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className="absolute inset-0 flex items-center justify-center p-10 bg-black/35 pointer-events-none"
                      >
                        <div className="text-center space-y-6 max-w-lg">
                          <p className="font-serif text-2xl md:text-3xl text-white italic leading-relaxed drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
                            "{selectedVerse.text}"
                          </p>
                          <div className="flex items-center justify-center gap-4">
                            <div className="h-[1px] w-10 bg-action-tan/60" />
                            <span className="font-display text-base font-bold tracking-[0.25em] text-action-tan drop-shadow-lg uppercase">
                              {selectedVerse.reference}
                            </span>
                            <div className="h-[1px] w-10 bg-action-tan/60" />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* No manual controls to avoid any play symbols */}
                </>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-white/20 p-12 text-center">
                  <Upload className="w-20 h-20 mb-6 stroke-1" />
                  <p className="font-display text-lg tracking-widest uppercase font-bold">Faça upload de um vídeo</p>
                  <p className="text-sm mt-3 opacity-50 font-serif italic">O versículo selecionado aparecerá aqui como overlay</p>
                </div>
              )}
            </div>

            <div className="glass-card rounded-3xl p-8 space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm text-text-dark font-bold tracking-widest uppercase">Configurações de Mídia</h3>
                <div className="flex gap-4">
                  <label className="text-xs text-action-tan hover:underline cursor-pointer font-bold uppercase tracking-tighter flex items-center gap-1">
                    <Upload className="w-3 h-3" />
                    Logo Marca
                    <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                  </label>
                  {videoUrl && (
                    <>
                      <label className="text-xs text-action-tan hover:underline cursor-pointer font-bold uppercase tracking-tighter">
                        Trocar Vídeo
                        <input type="file" accept="video/*" onChange={handleVideoUpload} className="hidden" />
                      </label>
                      <button 
                        onClick={() => {
                          setVideoUrl(null);
                          setVideoFile(null);
                          setRenderedBlob(null);
                          setVideoDuration(0);
                        }}
                        className="text-xs text-red-500 hover:underline font-bold uppercase tracking-tighter"
                      >
                        Remover
                      </button>
                    </>
                  )}
                </div>
              </div>

              {logoUrl && (
                <div className="flex items-center gap-4 p-4 bg-action-tan/5 rounded-2xl border border-action-tan/20">
                  <div className="w-12 h-12 rounded-full overflow-hidden border border-action-tan/30 bg-white">
                    <img src={logoUrl} alt="Logo" className="w-full h-full object-contain" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold text-text-dark uppercase tracking-wider">Logo Ativa</p>
                    <p className="text-[9px] text-text-muted">Sua logo aparecerá no topo dos vídeos gerados.</p>
                  </div>
                  <button 
                    onClick={() => setLogoUrl(null)}
                    className="p-1.5 hover:bg-red-50 rounded-full text-red-400 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4">
                {!videoUrl ? (
                  <label className="flex flex-col items-center justify-center gap-3 p-10 border-2 border-dashed border-action-tan/20 rounded-2xl cursor-pointer hover:bg-action-tan/5 transition-colors group">
                    {isRendering ? (
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-8 h-8 border-3 border-action-tan border-t-transparent rounded-full animate-spin" />
                        <span className="text-[10px] font-bold uppercase tracking-tighter text-action-tan">Processando Vídeo...</span>
                      </div>
                    ) : (
                      <>
                        <Upload className="w-8 h-8 text-action-tan group-hover:scale-110 transition-transform" />
                        <span className="text-sm font-bold text-text-muted uppercase tracking-widest">Selecionar Vídeo Local</span>
                        <input type="file" accept="video/*" onChange={handleVideoUpload} className="hidden" />
                      </>
                    )}
                  </label>
                ) : !renderedBlob ? (
                  <div className="flex flex-col gap-4">
                    {videoDuration > 0 && (
                      <div className="flex items-center justify-center gap-2 py-1.5 px-4 bg-action-tan/10 rounded-full self-center">
                        <div className="w-2 h-2 rounded-full bg-action-tan animate-pulse" />
                        <span className="text-[10px] font-bold text-action-tan uppercase tracking-widest">
                          Duração: {videoDuration.toFixed(1)}s
                        </span>
                      </div>
                    )}
                    {!selectedVerse && (
                      <div className="p-4 bg-action-tan/5 border border-action-tan/20 rounded-2xl text-center">
                        <p className="text-[10px] text-text-dark uppercase font-bold tracking-wider">
                          ⚠️ Selecione um versículo primeiro
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-1 gap-4">
                      <div 
                        className={cn(
                          "flex flex-col items-center justify-center gap-3 p-8 bg-text-dark text-white rounded-2xl transition-all shadow-lg relative overflow-hidden w-full",
                          (!videoUrl || !selectedVerse || isRendering) ? "opacity-50 cursor-not-allowed" : "hover:bg-text-dark/90 hover:shadow-xl cursor-pointer"
                        )}
                        onClick={() => {
                          if (!videoUrl || !selectedVerse || isRendering) return;
                          handleRender();
                        }}
                      >
                        <Video className="w-8 h-8 text-action-tan" />
                        <span className="text-sm font-bold uppercase tracking-widest">Gerar Vídeo para Compartilhar</span>
                      </div>
                      
                      <button 
                        onClick={handleDownloadImage}
                        disabled={!videoUrl || !selectedVerse || isRendering}
                        className="flex items-center justify-center gap-3 p-5 border-2 border-action-tan/30 text-action-tan rounded-2xl hover:bg-action-tan/5 transition-all disabled:opacity-30"
                      >
                        <Download className="w-5 h-5" />
                        <span className="text-sm font-bold uppercase tracking-widest">Baixar Imagem Rápida</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    <button 
                      onClick={handleShare}
                      className="flex flex-col items-center justify-center gap-3 p-8 bg-text-dark text-white rounded-2xl hover:bg-text-dark/90 transition-all shadow-lg hover:shadow-xl"
                    >
                      <Share2 className="w-8 h-8 text-action-tan" />
                      <span className="text-xs font-bold uppercase tracking-widest">
                        {canNativeShare ? 'Compartilhar' : 'Baixar p/ Postar'}
                      </span>
                    </button>
                    <button 
                      onClick={handleDownload}
                      className="flex flex-col items-center justify-center gap-3 p-8 bg-action-tan text-white rounded-2xl hover:bg-action-tan/90 transition-all shadow-lg hover:shadow-xl"
                    >
                      <Download className="w-8 h-8 text-white" />
                      <span className="text-xs font-bold uppercase tracking-widest">Salvar Galeria</span>
                    </button>
                    <button 
                      onClick={() => copyToClipboard(`"${selectedVerse.text}" - ${selectedVerse.reference}`)}
                      className="col-span-2 flex items-center justify-center gap-3 p-4 bg-text-muted/5 text-text-dark rounded-2xl border border-text-muted/10 hover:bg-text-muted/10 transition-all"
                    >
                      <Copy className="w-5 h-5" />
                      <span className="text-xs font-bold uppercase tracking-widest">Copiar Legenda do Versículo</span>
                    </button>
                    <button 
                      onClick={() => setRenderedBlob(null)}
                      className="col-span-2 text-xs text-text-muted hover:text-text-dark transition-colors py-3 font-bold uppercase tracking-widest border-t border-text-muted/5 mt-2"
                    >
                      Gerar outro com este vídeo
                    </button>
                  </div>
                )}
              </div>

              {!selectedVerse && (
                <div className="flex items-center gap-3 p-4 bg-action-tan/5 rounded-2xl border border-action-tan/20">
                  <BookOpen className="w-5 h-5 text-action-tan" />
                  <p className="text-[10px] text-text-muted font-bold uppercase tracking-wider">Dica: Selecione um versículo na lista à esquerda para ver o overlay.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="py-12 px-6 border-t border-text-muted/10 text-center bg-white/50">
        <div className="flex items-center justify-center gap-3 mb-4">
          <BookOpen className="w-5 h-5 text-secondary-green" />
          <div className="h-[1px] w-12 bg-text-muted/20" />
          <Cross className="w-5 h-5 text-action-tan" />
        </div>
        <h4 className="font-display text-lg font-bold text-text-dark mb-2 tracking-widest">RESULTADOS DA BÍBLIA</h4>
        <p className="font-serif text-xs text-text-muted italic max-w-md mx-auto leading-relaxed">
          "Lâmpada para os meus pés é tua palavra, e luz para o meu caminho."
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <div className="w-8 h-[1px] bg-text-muted/10" />
          <p className="text-[10px] text-text-muted/40 font-bold tracking-[0.2em] uppercase">
            A Palavra Diária &copy; {new Date().getFullYear()}
          </p>
          <div className="w-8 h-[1px] bg-text-muted/10" />
        </div>
      </footer>
    </div>
  );
}
