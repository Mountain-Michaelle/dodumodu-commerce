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
  var a=document.getElementById('benefits'),past=false,on=false,shown=null,q=false,scrolled=false;
  function read(){
    q=false;var r;
    past=a?a.getBoundingClientRect().top<innerHeight+S:false;
    if(H){r=H.getBoundingClientRect();on=r.top<innerHeight-p&&r.bottom>0;}else on=false;
    var n=past&&!on&&scrolled;
    if(n)document.documentElement.style.setProperty('--stick-h',b.offsetHeight+'px');
    if(n!==shown){shown=n;b.classList.toggle('is-on',n);document.body.classList.toggle('stick-on',n);}
  }
  function t(){if(!q){q=true;(requestAnimationFrame||setTimeout)(read);}}
  // Scroll event: add .is-on only after user scrolls past benefits section
  function onScroll(){
    scrolled=true;
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