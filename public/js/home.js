/* 사진 축소는 app.js의 compressImage()가 한다 — Level 3 풀이 사진 업로드도 같은 함수를
   쓰기 때문이다. 예전엔 이 파일 안에만 있어서 Level 3는 원본을 그대로 보내다 서버 상한에
   걸렸다. */

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
      base64 = await compressImage(file);
    } catch (err) {
      console.error('이미지 처리 실패:', err);
      Toast.show('사진을 읽지 못했어요. 다른 사진으로 시도해주세요.');
      return;
    }

    KeywordScreen.start(base64);
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
