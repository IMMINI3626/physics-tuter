/* 업로드 사진 축소 기준.
   원본 폰 사진(4000×3000, 5MB+)을 base64로 만들면 약 1.33배로 부풀어 callable 함수의
   요청 크기 한도에 걸린다. 걸리면 사용자에겐 "다시 업로드해주세요"만 보이고 몇 번을
   다시 해도 똑같이 실패한다. 보내기 전에 줄여서 실패율·응답속도·API 비용을 한 번에 낮춘다.
   1600px는 교과서 글씨를 Gemini가 읽어내는 데 충분한 해상도. */
const IMAGE_MAX_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.8;

const HomeScreen = {
  init() {
    this._bindUploadZone();
    this._bindUploadButtons();
    GuestGuard._updateUI();
  },

  _bindUploadZone() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('click', () => {
      if (this._checkGuestLimit()) return;
      this._openFilePicker();
    });
  },

  _bindUploadButtons() {
    document.getElementById('btn-camera')?.addEventListener('click', e => {
      e.stopPropagation();
      if (this._checkGuestLimit()) return;
      this._openCamera();
    });
    document.getElementById('btn-gallery')?.addEventListener('click', e => {
      e.stopPropagation();
      if (this._checkGuestLimit()) return;
      this._openFilePicker();
    });
  },

  /* 게스트 제한 체크: 도달 시 안내 + 모달, true 반환 시 상위 동작 중단 */
  _checkGuestLimit() {
    if (GuestGuard.isLimitReached()) {
      Toast.show('무료 체험 3회를 모두 사용했어요. 로그인하고 계속 학습해보세요!');
      Modal.open('login-modal');
      return true;
    }
    return false;
  },

  _openFilePicker() {
    document.getElementById('file-input')?.click();
  },

  _openCamera() {
    document.getElementById('camera-input')?.click();
  },

  async handleFileSelect(file) {
    // 🔒 2차 방어: 파일 선택창까지 열린 뒤에도 한 번 더 체크
    if (this._checkGuestLimit()) return;

    if (!file || !file.type.startsWith('image/')) {
      Toast.show('이미지 파일을 선택해주세요');
      return;
    }

    // 🔑 게스트 카운트는 여기서 올리지 않는다 — 분석에 성공했을 때만 차감해야
    //    AI 인식 실패로 아무것도 못 해보고 무료 횟수만 날리는 일이 없다.
    //    실제 증가 지점은 keyword.js의 extractKeywords 성공 직후.

    let base64;
    try {
      base64 = await this._compressImage(file);
    } catch (err) {
      console.error('이미지 처리 실패:', err);
      Toast.show('사진을 읽지 못했어요. 다른 사진으로 시도해주세요.');
      return;
    }

    AppState.session.uploadedImageBase64 = base64;
    KeywordScreen.start(base64);
  },

  /* 긴 변이 IMAGE_MAX_EDGE를 넘으면 비율을 유지한 채 축소하고 JPEG로 재인코딩.
     이미 작은 사진도 JPEG로 통일해서 보낸다 (PNG 스크린샷이 오히려 더 큰 경우가 많음). */
  async _compressImage(file) {
    const source = await this._decodeImage(file);
    const srcW = source.width  || source.naturalWidth;
    const srcH = source.height || source.naturalHeight;
    if (!srcW || !srcH) throw new Error('이미지 크기를 읽을 수 없습니다');

    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // 사진 배경이 투명한 PNG일 때 JPEG로 바꾸면 검게 깔리므로 흰 바탕을 먼저 칠함
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    source.close?.();   // ImageBitmap이면 메모리 해제

    return canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY);
  },

  /* 🔑 EXIF 회전 정보 처리가 핵심 — 폰으로 세로로 찍은 사진은 실제 픽셀은 가로로 저장되고
     "90도 돌려서 보여줘"라는 EXIF 태그가 따로 붙는다. 이걸 무시하고 캔버스에 그리면
     교과서 사진이 옆으로 누운 채 Gemini에 전달되어 인식률이 크게 떨어진다.
     createImageBitmap의 imageOrientation:'from-image'가 이 회전을 적용해준다. */
  async _decodeImage(file) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) {
        // 구형 브라우저는 options 인자를 지원하지 않음 — <img> 경로로 폴백
        console.warn('createImageBitmap 실패, img 폴백:', e);
      }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 디코딩 실패')); };
      img.src = url;
    });
  },

};

document.addEventListener('DOMContentLoaded', () => {
  HomeScreen.init();

  document.getElementById('file-input')?.addEventListener('change', function () {
    if (this.files[0]) HomeScreen.handleFileSelect(this.files[0]);
    this.value = '';
  });
  document.getElementById('camera-input')?.addEventListener('change', function () {
    if (this.files[0]) HomeScreen.handleFileSelect(this.files[0]);
    this.value = '';
  });
});
