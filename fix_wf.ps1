$content = Get-Content .github/workflows/deploy-storefront.yml -Raw
$old = [string]::Format("EXPECTED_BUILD_ID: ${{ steps.render.outputs.build_id }}`n          # The verifier fetches /:slug for every intended publication and reads`n          # the storefront-publish-id / storefront-build-id markers, then`n          # re-reads the newest publishes to refuse a stale build. Mismatch,`n          # stale response, or timeout => build stays PUBLISHED/pending with a`n          # verification-failure record; retry is`n          # `gh workflow run deploy-storefront.yml`")
$new = [string]::Format("EXPECTED_BUILD_ID: ${{ steps.render.outputs.build_id }}`n          WORKER_URL: ${{ secrets.WORKER_URL }}`n          DEPLOY_TRIGGER_SECRET: ${{ secrets.DEPLOY_TRIGGER_SECRET }}")
if ($content.Contains($old)) {
    $content = $content.Replace($old, $new)
    Set-Content .github/workflows/deploy-storefront.yml $content -NoNewline
    Write-Host "Replaced comment block"
} else {
    Write-Host "Old text not found"
    $idx = $content.IndexOf("EXPECTED_BUILD_ID")
    if ($idx -ge 0) { Write-Host $content.Substring($idx, 300) }
}
