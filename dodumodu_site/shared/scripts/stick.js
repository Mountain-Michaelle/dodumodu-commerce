/* stick.js: the site header [data-stick] IS the sticky bar — toggles .is-on (position:fixed
   pin, see sticky.css) [data-stick-show-px] before #benefits and off [data-stick-hide-px]
   before #order-form. Single header in the markup; nothing is cloned. */
(function(){
  var b=document.querySelector('[data-stick]');
  if(!b||b.getAttribute('data-stick-ready'))return;
  b.setAttribute('data-stick-ready','1');
  var H=document.querySelector(b.getAttribute('data-stick-hide')||''),p=+b.getAttribute('data-stick-hide-px')||50;
  if(p<0||p>400)p=50;
  var S=+b.getAttribute('data-stick-show')||100;
  if(S<0||S>400)S=100;
  var a=document.getElementById('benefits'),shown=false,q=false;
  function read(){
    q=false;var r,near,hidden;
    // .is-on only while within S px of reaching #benefits (scrolling down), and cleared
    // again when scrolling back up past the same S-px threshold - same spot both ways.
    near=a?a.getBoundingClientRect().top<S:false;
    hidden=false;
    if(H){r=H.getBoundingClientRect();hidden=r.top<innerHeight-p&&r.bottom>0;}
    var n=near&&!hidden;
    if(n)document.documentElement.style.setProperty('--stick-h',b.offsetHeight+'px');
    if(n!==shown){shown=n;b.classList.toggle('is-on',n);document.body.classList.toggle('stick-on',n);}
  }
  function t(){if(!q){q=true;(requestAnimationFrame||setTimeout)(read);}}
  function onScroll(){
    if(q)return;
    q=true;
    read();
    setTimeout(()=>{q=false},100);
  }
  addEventListener('scroll',onScroll,{passive:true});
  addEventListener('resize',onScroll,{passive:true});
  if('IntersectionObserver'in window){
    var w=function(){t();setTimeout(t,60);};
    if(a)new IntersectionObserver(w,{rootMargin:'0px 0px -'+S+'px 0px'}).observe(a);
    if(H)new IntersectionObserver(w,{rootMargin:'0px 0px -'+p+'px 0px'}).observe(H);
  }
  ['load','pageshow'].forEach(e=>addEventListener(e,()=>setTimeout(read,100)));
})();