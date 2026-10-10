//! Deterministic, in-process provider world used by adapter and reducer tests.
use anvil_reconcile::github::{CheckRun, CommitStatus};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderFailure { Unavailable, RateLimited }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequest { pub number:u64, pub head_sha:String, pub evaluation_sha:String, pub merged:bool, pub open:bool }
#[derive(Clone, Debug, Default)]
pub struct TestWorld { pub pull_requests:Vec<PullRequest>, pub check_runs:Vec<CheckRun>, pub statuses:Vec<CommitStatus>, pub failure:Option<ProviderFailure>, pub collection_sequence:u64 }
impl TestWorld {
    pub fn observe(&mut self, number:u64)->Result<(PullRequest,Vec<CheckRun>,Vec<CommitStatus>,u64),ProviderFailure> {
        if let Some(e)=self.failure.clone(){return Err(e)}
        let pr=self.pull_requests.iter().find(|p|p.number==number).cloned().expect("fixture PR exists");
        self.collection_sequence+=1;
        Ok((pr,self.check_runs.clone(),self.statuses.clone(),self.collection_sequence))
    }
    pub fn set_failure(&mut self, failure:Option<ProviderFailure>){self.failure=failure;}
    pub fn advance_head(&mut self,number:u64,head:&str,evaluation:&str){if let Some(pr)=self.pull_requests.iter_mut().find(|p|p.number==number){pr.head_sha=head.into();pr.evaluation_sha=evaluation.into();}}
    pub fn set_merged(&mut self,number:u64){if let Some(pr)=self.pull_requests.iter_mut().find(|p|p.number==number){pr.merged=true;pr.open=false;}}
}
#[cfg(test)] mod tests { use super::*; #[test] fn explicit_advances_are_deterministic_and_failures_preserve_facts(){let mut w=TestWorld{pull_requests:vec![PullRequest{number:7,head_sha:"h1".into(),evaluation_sha:"m1".into(),merged:false,open:true}],..Default::default()};assert_eq!(w.observe(7).unwrap().3,1);w.advance_head(7,"h2","m2");assert_eq!(w.observe(7).unwrap().0.head_sha,"h2");w.set_failure(Some(ProviderFailure::Unavailable));assert_eq!(w.observe(7),Err(ProviderFailure::Unavailable));assert_eq!(w.pull_requests[0].head_sha,"h2");} }
