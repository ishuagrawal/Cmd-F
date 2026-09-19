// Keep live DOM and fetched HTML coverage aligned. Inline descendants belong to
// their enclosing passage, so emphasis and code are not separate duplicate hits.
export const semanticPassage =
  'h1,h2,h3,h4,h5,h6,p,li,pre,table,dt,dd,blockquote,figcaption,caption,address,label,legend,output,dialog,[role="heading"],[role="paragraph"],[role="status"],[role="alert"],[role="log"],div[lang],[data-testid="tweetText"]';
export const genericText =
  'body,main,article,section,aside,header,footer,nav,div,span,a,strong,em,b,i,u,s,small,mark,code,kbd,samp,var,q,cite,abbr,dfn,time,data,sub,sup,del,ins';
export const textBoundary =
  'main,article,section,aside,header,footer,nav,div,ul,ol,dl,figure,form,fieldset,details,' +
  semanticPassage;
export const interactiveText =
  'a[href],button,summary,[role="button"],[role="tab"],[role="menuitem"]';
