// A passing view is sufficient to retain the whole frame. Rejected frames must
// still complete all five views. The recorded score is the max of evaluated views.
async function scorePeopleViews(scoreView, stopAt) {
  if(stopAt!==undefined&&(!Number.isFinite(stopAt)||stopAt< -1||stopAt>1))throw new Error('Invalid People screening threshold.');
  let people=-1,views=0;
  for(let i=0;i<5;i++){
    const score=await scoreView(i);
    if(!Number.isFinite(score)||score< -1||score>1)throw new Error('Invalid People view score.');
    people=Math.max(people,score);views++;
    if(stopAt!==undefined&&people>=stopAt)break;
  }
  return {people,...(stopAt===undefined?{}:{_screening:{version:1,views_scored:views,views_total:5,threshold:stopAt,complete_max:views===5}})};
}
module.exports={scorePeopleViews};
