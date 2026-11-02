import { Hono } from 'hono';
import { adminRoute } from './src/routes/admin';

const app = new Hono();
app.route('/admin', adminRoute);

async function test() {
  // Test 1: /admin/ with auth header
  const res1 = await app.fetch(new Request('http://localhost/admin/', { headers: { 'cf-access-authenticated-user-email': 'admin@example.com' } }));
  console.log('Test 1 - /admin/ with auth:');
  console.log('  status:', res1.status);
  console.log('  content-type:', res1.headers.get('content-type'));
  const body1 = await res1.text();
  console.log('  body includes console:', body1.includes('<!doctype html>'));
  
  // Test 2: /admin with auth header
  const res2 = await app.fetch(new Request('http://localhost/admin', { headers: { 'cf-access-authenticated-user-email': 'admin@example.com' } }));
  console.log('\nTest 2 - /admin with auth:');
  console.log('  status:', res2.status);
  
  // Test 3: /admin/sign-in
  const res3 = await app.fetch(new Request('http://localhost/admin/sign-in/'));
  console.log('\nTest 3 - /admin/sign-in/ unauth:');
  console.log('  status:', res3.status);
  
  // Test 4: /admin/devices
  const res4 = await app.fetch(new Request('http://localhost/admin/devices', { headers: { 'cf-access-authenticated-user-email': 'admin@example.com' } }));
  console.log('\nTest 4 - /admin/devices with auth:');
  console.log('  status:', res4.status);
}
test();