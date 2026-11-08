$env:DATABASE_URL = "postgresql://postgres@localhost:55432/dodumodu"
cd "C:\Users\Chinedu\Documents\web_work\dodumodu\dodumodu_backend"
npm run test:db > "C:\Users\Chinedu\Documents\web_work\dodumodu\test-output.log" 2>&1
exit $LASTEXITCODE