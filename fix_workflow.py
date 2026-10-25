content = open('.github/workflows/deploy-storefront.yml', 'r').read()
old = '''          EXPECTED_BUILD_ID: ${{ steps.render.outputs.build_id }}
          # The verifier fetches /:slug for every intended publication and reads
          # the storefront-publish-id / storefront-build-id markers, then
          # re-reads the newest publishes to refuse a stale build. Mismatch,
          # stale response, or timeout => build stays PUBLISHED/pending with a
          # verification-failure record; retry is
          # `gh workflow run deploy-storefront.yml`."'''
new = '''          EXPECTED_BUILD_ID: ${{ steps.render.outputs.build_id }}
          WORKER_URL: ${{ secrets.WORKER_URL }}
          DEPLOY_TRIGGER_SECRET: ${{ secrets.DEPLOY_TRIGGER_SECRET }}'''
new_step = '''
      - name: Record build failure
        if: failure()
        working-directory: dodumodu_backend
        run: |
          BUILD_ID="${{ steps.render.outputs.build_id }}"
          if [ -n "$BUILD_ID" ]; then
            curl -s -X POST "${WORKER_URL}/admin/builds/${BUILD_ID}/mark-failed" \\
              -H "Authorization: Bearer ${DEPLOY_TRIGGER_SECRET}" \\
              -H "Content-Type: application/json" \\
              -d '{"error":"workflow step failed before verification completed"}' \\
              || echo "mark-failed callback failed (check Worker logs)"
          else
            echo "No build ID available — build was not recorded as triggered"
          fi
        env:
          WORKER_URL: ${{ secrets.WORKER_URL }}
          DEPLOY_TRIGGER_SECRET: ${{ secrets.DEPLOY_TRIGGER_SECRET }}'''
if old in content:
    content = content.replace(old, new + new_step)
    open('.github/workflows/deploy-storefront.yml', 'w').write(content)
    print('Replacement successful')
else:
    print('Old text not found')
    idx = content.find('EXPECTED_BUILD_ID')
    if idx >= 0:
        print(repr(content[idx:idx+500]))
