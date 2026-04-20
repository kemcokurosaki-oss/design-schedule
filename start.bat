@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo 設計工程表をローカルサーバーで開きます（file:// の制限を避けます）
echo 終了するときはこの黒いウィンドウを閉じるか Ctrl+C を押してください。
echo.
set PORT=5173
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/"
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python -m http.server %PORT%
  goto :eof
)
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  npx --yes serve . -p %PORT%
  goto :eof
)
echo Python も Node も見つかりませんでした。
echo Python 3 または Node.js をインストールしてから再度実行してください。
pause
