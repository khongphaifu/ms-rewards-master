@echo off
chcp 65001 > nul
title Tự động khởi chạy Microsoft Rewards

echo ========================================================
echo   MICROSOFT REWARDS MASTER - TỰ ĐỘNG KHỞI CHẠY EDGE
echo ========================================================
echo.
echo [1/2] Đang kiểm tra trình duyệt Microsoft Edge...

set EDGE_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist %EDGE_PATH% (
    set EDGE_PATH="C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)

if not exist %EDGE_PATH% (
    echo [LỖI] Không tìm thấy file msedge.exe trên hệ thống!
    pause
    exit /b 1
)

echo [2/2] Đang khởi chạy Microsoft Edge đến trang Microsoft Rewards...
start "" %EDGE_PATH% "https://rewards.bing.com/"

echo.
echo [THÀNH CÔNG] Microsoft Edge đã được mở. 
echo Nếu bạn đã bật tùy chọn "Tự động chạy khi mở Edge" trong Extension, 
echo quy trình sẽ tự động thực hiện toàn bộ nhiệm vụ và tìm kiếm Bing.
echo.
timeout /t 5 > nul
exit
